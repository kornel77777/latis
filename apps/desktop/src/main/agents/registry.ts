import { join } from "node:path";
import type { AgentAdapter, AgentInfo, AuthStatus, DetectResult, PermissionMode } from "@latis/shared";
import type { PtyManager } from "../terminal/pty-manager";
import { AcpAdapter } from "./adapters/acp";
import { ClaudeCodeAdapter } from "./adapters/claude-code";
import { createReplayQuery } from "./adapters/claude-code/replay";
import { CodexAdapter } from "./adapters/codex";
import { FakeAdapter } from "./adapters/fake";
import { TerminalAdapter } from "./adapters/terminal";
import { fakeScripts } from "./fixtures";
import { BUILT_IN_MANIFESTS, loadManifests } from "./manifests";
import { ReplayLibrary, replayTransport } from "./rpc/replay";

export interface RegistryOptions {
  dataDir: string;
  ptys: PtyManager;
  fakeRunnerPath: string;
  /** LATIS_REPLAY=<fixtures dir>: agents replay recordings instead of starting CLIs (e2e; no network, no tokens). */
  replayRoot?: string;
}

/** Permission modes each kind of adapter can't fully enforce (§9.8 AC3). */
function unenforceable(a: AgentAdapter): PermissionMode[] {
  if (a instanceof TerminalAdapter) return ["read-only", "ask", "auto-edit", "full-auto"];
  if (a instanceof FakeAdapter) return [];
  return ["full-auto"];
}

/** All agents Latis knows: built-in adapters plus manifest agents from <dataDir>/agents (§6.4). */
export class AgentRegistry {
  readonly adapters = new Map<string, AgentAdapter>();
  manifestErrors: Record<string, string> = {};
  private builtIn: AgentAdapter[];
  private info: Promise<AgentInfo[]> | null = null;

  constructor(private readonly opts: RegistryOptions) {
    const root = opts.replayRoot;
    const lib = (dir: string, fallback: string, turnMethod: string, stubs?: Record<string, unknown>) =>
      new ReplayLibrary(join(root!, dir), { fallback, turnMethod, ...(stubs && { stubs }) });
    const claude = new ClaudeCodeAdapter(
      root ? { queryFn: createReplayQuery(join(root, "claude-code")), executable: "/replay/claude" } : {},
    );
    const codexLib = root ? lib("codex", "write-and-run", "turn/start") : null;
    const codex = new CodexAdapter(codexLib ? { transport: (cwd) => replayTransport(codexLib, cwd), executable: "/replay/codex" } : {});
    this.builtIn = [claude, codex, new FakeAdapter({ runnerPath: opts.fakeRunnerPath, scripts: fakeScripts })];
    this.load();
  }

  get agentsDir(): string {
    return join(this.opts.dataDir, "agents");
  }

  /** (Re)reads manifests. Built-in adapter instances (and their caches) are kept. */
  load(): void {
    const reserved = this.builtIn.map((a) => a.id);
    const { manifests, errors } = loadManifests(this.agentsDir, reserved);
    this.manifestErrors = errors;
    this.adapters.clear();
    for (const a of this.builtIn) this.adapters.set(a.id, a);
    const root = this.opts.replayRoot;
    const acpLib = root
      ? new ReplayLibrary(join(root, "acp"), {
          fallback: "gemini-write-run",
          include: (n) => n.startsWith("gemini-"),
          turnMethod: "session/prompt",
          stubs: { "session/set_mode": {}, "session/set_config_option": {} },
        })
      : null;
    for (const m of manifests) {
      const adapter =
        m.protocol === "acp"
          ? new AcpAdapter(m, {
              probeDir: join(this.opts.dataDir, "probe"),
              // Replay only stands in for the built-in ACP agent; user manifests stay real.
              ...(acpLib &&
                BUILT_IN_MANIFESTS.some((b) => b.id === m.id) && {
                  transport: (cwd: string) => replayTransport(acpLib, cwd),
                  executable: `/replay/${m.id}`,
                }),
            })
          : new TerminalAdapter(m, this.opts.ptys);
      this.adapters.set(m.id, adapter);
    }
    this.info = null;
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  isTerminal(id: string): boolean {
    return this.adapters.get(id) instanceof TerminalAdapter;
  }

  list(refresh = false): Promise<AgentInfo[]> {
    if (refresh) {
      this.load();
      for (const a of this.adapters.values()) (a as { refresh?: () => void }).refresh?.();
    }
    const builtInIds = new Set([...this.builtIn.map((a) => a.id), ...BUILT_IN_MANIFESTS.map((m) => m.id)]);
    this.info ??= Promise.all(
      [...this.adapters.values()].map(async (a): Promise<AgentInfo> => {
        const d: DetectResult = await a.detect().catch(() => ({ installed: false }));
        const auth: AuthStatus = d.installed ? await a.authStatus().catch(() => ({ signedIn: false })) : { signedIn: false };
        const hint = (a as { installHint?: string }).installHint;
        const terminal = a instanceof TerminalAdapter;
        return {
          id: a.id,
          displayName: a.displayName,
          hue: a.hue,
          installed: d.installed,
          signedIn: auth.signedIn,
          unenforceable: unenforceable(a),
          kind: terminal ? "terminal" : "structured",
          steering: a.capabilities.steering,
          canSignIn: Boolean(a.login) && !terminal,
          source: builtInIds.has(a.id) ? "built-in" : "manifest",
          ...(d.version && { version: d.version }),
          ...(auth.account && { account: auth.account }),
          ...(hint && { installHint: hint }),
        };
      }),
    );
    return this.info;
  }
}
