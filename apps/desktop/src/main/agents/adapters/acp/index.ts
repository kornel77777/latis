import { mkdirSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type {
  AgentAdapter,
  AgentSession,
  AuthStatus,
  DetectResult,
  LoginHandle,
  ModelInfo,
  PermissionMode,
  RequestResponse,
  SessionOptions,
  UserTurn,
} from "@latis/shared";
import type { AgentManifest } from "../../manifests";
import { JsonRpcPeer, RpcError, type Params } from "../../rpc/peer";
import { spawnTransport, type LineTransport } from "../../rpc/transport";
import { SessionBase } from "../../session-base";
import { shellEnv, versionOf, which } from "../../shell-env";
import { AcpMapper, type SessionUpdate, type ToolCall } from "./mapper";

// Any agent speaking the Agent Client Protocol, described by a manifest (SPEC §6.3–6.4, docs/adapters/acp.md).

interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}
interface NewSessionResult {
  sessionId?: string;
  modes?: { currentModeId: string; availableModes: { id: string; name: string }[] } | null;
  configOptions?: ConfigOption[] | null;
  models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string }[] } | null;
}
interface InitializeResult {
  agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean } };
}
type PermissionOption = { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };

/** Well-known mode ids per Latis mode, used when a manifest doesn't map them. */
const MODE_ALIASES: Record<PermissionMode, string[]> = {
  "read-only": ["plan", "read-only", "readonly", "read_only"],
  ask: ["default", "ask", "manual"],
  "auto-edit": ["autoEdit", "auto_edit", "auto-edit", "acceptEdits", "accept_edits"],
  "full-auto": ["yolo", "bypassPermissions", "full-auto", "full_auto", "full-access"],
};
const READ_KINDS = new Set(["read", "search", "fetch", "think", "switch_mode"]);
const EDIT_KINDS = new Set(["edit", "delete", "move"]);
const CLIENT_INFO = { name: "latis", title: "Latis", version: "0.1.0" };

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (err instanceof RpcError && err.code === -32000) || /auth|sign.?in|log.?in|api key/i.test(msg);
}

export interface AcpAdapterOptions {
  transport?: (cwd: string) => LineTransport;
  executable?: string | null;
  /** Folder for probe sessions (auth and model checks). */
  probeDir: string;
}

export class AcpAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly hue: string;
  readonly installHint: string | undefined;
  readonly capabilities = {
    streaming: true,
    steering: false,
    images: true,
    resume: true,
    permissions: "native",
    plans: false,
    questions: false,
    subagents: false,
    mcp: true,
    reasoningLevels: true,
    usageReporting: false,
    nativeTerminal: true,
  } as const;

  private binary: Promise<string | null> | null = null;
  private auth: AuthStatus | null = null;
  /** Options from the latest session, for the model picker. */
  private lastOptions: NewSessionResult | null = null;

  constructor(
    readonly manifest: AgentManifest,
    private readonly opts: AcpAdapterOptions,
  ) {
    this.id = manifest.id;
    this.displayName = manifest.displayName;
    this.hue = manifest.hue;
    this.installHint = manifest.installHint;
  }

  private executable(): Promise<string | null> {
    if (this.opts.executable !== undefined) return Promise.resolve(this.opts.executable);
    this.binary ??= which(this.manifest.command);
    return this.binary;
  }

  refresh(): void {
    this.binary = null;
    this.auth = null;
  }

  async transport(cwd: string): Promise<LineTransport> {
    if (this.opts.transport) return this.opts.transport(cwd);
    const bin = await this.executable();
    if (!bin) throw new Error(`${this.displayName} isn't installed.${this.installHint ? ` Install it with: ${this.installHint}` : ""}`);
    return spawnTransport({ file: bin, args: this.manifest.args, cwd, env: await shellEnv() });
  }

  async detect(): Promise<DetectResult> {
    const bin = await this.executable();
    if (!bin) return { installed: false };
    const version = this.opts.transport ? "test" : await versionOf(bin, this.manifest.detect.versionArgs);
    return { installed: true, binaryPath: bin, ...(version && { version }) };
  }

  /** Opens a session without prompting (no tokens) to learn whether the agent is signed in and its models. */
  async authStatus(): Promise<AuthStatus> {
    if (this.auth) return this.auth;
    mkdirSync(this.opts.probeDir, { recursive: true });
    const transport = await this.transport(this.opts.probeDir);
    const peer = new JsonRpcPeer(
      transport,
      { request: () => Promise.reject(new RpcError("not supported", -32601)), notification: () => undefined },
      { jsonrpc: true },
    );
    try {
      await peer.request("initialize", initializeParams());
      this.lastOptions = await peer.request<NewSessionResult>("session/new", { cwd: this.opts.probeDir, mcpServers: [] });
      this.auth = { signedIn: true, method: "subscription" };
    } catch (err) {
      if (!isAuthError(err)) console.warn(`[${this.id}] auth probe failed`, err);
      this.auth = { signedIn: false, method: "none" };
    } finally {
      peer.close();
      transport.kill();
    }
    return this.auth;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.lastOptions) await this.authStatus();
    return modelsFrom(this.lastOptions);
  }

  rememberOptions(o: NewSessionResult): void {
    this.lastOptions = o;
  }

  async login(): Promise<LoginHandle> {
    const bin = (await this.executable()) ?? this.manifest.command;
    return { pty: { file: bin, args: this.manifest.login?.args ?? [], cwd: process.cwd() }, done: Promise.resolve({ signedIn: false }) };
  }

  terminalCommand(opts: SessionOptions & { nativeSessionId?: string }) {
    return { file: this.manifest.command, args: [], cwd: opts.cwd };
  }

  startSession(opts: SessionOptions): Promise<AgentSession> {
    return AcpSession.open(this, opts, undefined);
  }

  resumeSession(nativeSessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return AcpSession.open(this, opts, nativeSessionId);
  }
}

function initializeParams() {
  // No fs/terminal client capabilities: agents work on disk with their own tools and Latis observes.
  return {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: CLIENT_INFO,
  };
}

function modelsFrom(o: NewSessionResult | null): ModelInfo[] {
  if (!o) return [];
  const effort = o.configOptions?.find((c) => c.category === "thought_level");
  const levels = effort?.options.map((x) => x.value).filter((v) => v !== "default");
  const withLevels = (m: ModelInfo): ModelInfo => (levels?.length ? { ...m, reasoningLevels: levels } : m);
  const modelOpt = o.configOptions?.find((c) => c.category === "model");
  const list: ModelInfo[] = modelOpt
    ? modelOpt.options.map((x) => withLevels({ id: x.value, label: x.name, ...(x.description && { description: x.description }) }))
    : (o.models?.availableModels ?? []).map((m) =>
        withLevels({ id: m.modelId, label: m.name, ...(m.description && { description: m.description }) }),
      );
  return list.some((m) => m.id === "default") ? list : [withLevels({ id: "default", label: "Default" }), ...list];
}

class AcpSession extends SessionBase implements AgentSession {
  private peer!: JsonRpcPeer;
  private mapper: AcpMapper;
  private sessionId = "";
  private loading = false;
  private turnStart = 0;
  private interrupting = false;
  private pending = new Map<string, { call: ToolCall; options: PermissionOption[]; resolve: (r: unknown) => void }>();
  private mode: PermissionMode;
  private state: NewSessionResult = {};
  private images = false;
  private disposed = false;

  private constructor(
    private readonly adapter: AcpAdapter,
    private readonly transport: LineTransport,
    private readonly cwd: string,
    mode: PermissionMode,
  ) {
    super();
    this.mapper = new AcpMapper(cwd);
    this.mode = mode;
  }

  static async open(adapter: AcpAdapter, opts: SessionOptions, resume: string | undefined): Promise<AcpSession> {
    const transport = await adapter.transport(opts.cwd);
    const s = new AcpSession(adapter, transport, opts.cwd, opts.permissionMode);
    transport.onExit((info) => {
      if (s.disposed) return;
      for (const p of s.pending.values()) p.resolve({ outcome: { outcome: "cancelled" } });
      s.pending.clear();
      s.peer?.close(`${adapter.displayName} exited`);
      s.exit(info);
    });
    try {
      s.peer = new JsonRpcPeer(
        transport,
        { request: (method, params) => s.onRequest(method, params), notification: (method, params) => s.onNotification(method, params) },
        { jsonrpc: true },
      );
      const init = await s.peer.request<InitializeResult>("initialize", initializeParams());
      s.images = Boolean(init.agentCapabilities?.promptCapabilities?.image);
      if (resume && init.agentCapabilities?.loadSession) {
        // The agent replays the conversation as updates; Latis already has it in the event log.
        s.loading = true;
        s.state = await s.peer.request<NewSessionResult>("session/load", { sessionId: resume, cwd: opts.cwd, mcpServers: [] });
        s.loading = false;
        s.sessionId = resume;
      } else {
        s.state = await s.peer.request<NewSessionResult>("session/new", { cwd: opts.cwd, mcpServers: [] });
        s.sessionId = s.state.sessionId ?? "";
      }
      adapter.rememberOptions(s.state);
      await s.applyMode(opts.permissionMode);
      if (opts.model && opts.model !== "default") await s.setConfig("model", opts.model);
      if (opts.reasoning) await s.setConfig("thought_level", opts.reasoning);
      s.emit({ type: "session.started", nativeSessionId: s.sessionId, model: s.currentModel() });
      return s;
    } catch (err) {
      transport.kill();
      if (isAuthError(err))
        throw new Error(`${adapter.displayName} isn't signed in. Sign in from Settings → Agents, then try again.`, { cause: err });
      const detail = transport.stderrTail().split("\n").filter(Boolean).at(-1);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(detail && !msg.includes(detail) ? `${msg} (${detail})` : msg, { cause: err });
    }
  }

  private currentModel(): string {
    const opt = this.state.configOptions?.find((c) => c.category === "model");
    return opt?.currentValue ?? this.state.models?.currentModelId ?? this.adapter.displayName;
  }

  private modeId(mode: PermissionMode): string | undefined {
    const available = this.state.modes?.availableModes.map((m) => m.id) ?? [];
    const mapped = this.adapter.manifest.modes?.[mode];
    if (mapped && available.includes(mapped)) return mapped;
    return MODE_ALIASES[mode].find((id) => available.includes(id));
  }

  private async applyMode(mode: PermissionMode) {
    const id = this.modeId(mode);
    if (id && id !== this.state.modes?.currentModeId) {
      await this.peer.request("session/set_mode", { sessionId: this.sessionId, modeId: id });
      if (this.state.modes) this.state.modes.currentModeId = id;
    }
  }

  private async setConfig(category: string, value: string) {
    const opt = this.state.configOptions?.find((c) => c.category === category);
    if (!opt || !opt.options.some((o) => o.value === value)) return;
    const res = await this.peer.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", {
      sessionId: this.sessionId,
      configId: opt.id,
      value,
    });
    if (res.configOptions) this.state.configOptions = res.configOptions;
  }

  private onNotification(method: string, params: Params): void {
    if (method !== "session/update" || this.loading || params.sessionId !== this.sessionId) return;
    const u = params.update as SessionUpdate & { currentModeId?: string; configOptions?: ConfigOption[] };
    if (u.sessionUpdate === "current_mode_update" && this.state.modes && u.currentModeId) this.state.modes.currentModeId = u.currentModeId;
    if (u.sessionUpdate === "config_option_update" && u.configOptions) this.state.configOptions = u.configOptions;
    for (const e of this.mapper.update(u)) this.emit(e);
  }

  private insideCwd(call: ToolCall): boolean {
    const paths = [
      ...(call.locations ?? []).map((l) => l.path),
      ...(call.content ?? []).flatMap((c) => (c.type === "diff" ? [c.path] : [])),
    ];
    return (
      paths.length > 0 &&
      paths.every((p) => {
        const r = relative(this.cwd, p);
        return !r.startsWith("..") && !isAbsolute(r);
      })
    );
  }

  private pick(options: PermissionOption[], kinds: PermissionOption["kind"][]): unknown {
    const o = kinds.map((k) => options.find((x) => x.kind === k)).find(Boolean);
    return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
  }

  private onRequest(method: string, params: Params): Promise<unknown> {
    if (method !== "session/request_permission") return Promise.reject(new RpcError(`Latis doesn't provide ${method}`, -32601));
    const call = params.toolCall as ToolCall;
    const options = params.options as PermissionOption[];
    // Emulated modes on top of whatever the agent's own mode decides (docs/adapters/acp.md).
    const kind = call.kind ?? "other";
    if (this.mode === "full-auto") return Promise.resolve(this.pick(options, ["allow_once", "allow_always"]));
    if (this.mode === "read-only" && !READ_KINDS.has(kind)) {
      this.mapper.markDenied(call.toolCallId);
      return Promise.resolve(this.pick(options, ["reject_once", "reject_always"]));
    }
    if (this.mode === "auto-edit" && EDIT_KINDS.has(kind) && this.insideCwd(call)) {
      return Promise.resolve(this.pick(options, ["allow_once", "allow_always"]));
    }
    const requestId = call.toolCallId;
    return new Promise((resolve) => {
      this.pending.set(requestId, { call, options, resolve });
      for (const e of this.mapper.permission(requestId, call)) this.emit(e);
    });
  }

  async send(turn: UserTurn): Promise<void> {
    const prompt = [
      ...(this.images ? (turn.images ?? []) : []).map((img) => ({ type: "image", mimeType: img.mime, data: img.dataBase64 })),
      { type: "text", text: turn.text },
    ];
    this.turnStart = Date.now();
    // session/prompt resolves when the turn ends, so it isn't awaited here.
    this.peer
      .request<{ stopReason: string; usage?: { inputTokens?: number; outputTokens?: number } }>("session/prompt", {
        sessionId: this.sessionId,
        prompt,
      })
      .then((res) => {
        const reason = this.interrupting ? "cancelled" : res.stopReason;
        this.interrupting = false;
        for (const e of this.mapper.turnEnd(reason, Date.now() - this.turnStart, res.usage)) this.emit(e);
      })
      .catch((err: unknown) => {
        if (this.disposed) return;
        this.emit({ type: "error", message: err instanceof Error ? err.message : String(err), recoverable: true });
        for (const e of this.mapper.turnEnd("refusal", Date.now() - this.turnStart)) this.emit(e);
      });
  }

  async interrupt(): Promise<void> {
    this.interrupting = true;
    for (const p of this.pending.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
    this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (response.kind !== "permission") {
      p.resolve(this.pick(p.options, ["allow_once"]));
      return;
    }
    if (response.decision === "deny") {
      this.mapper.markDenied(p.call.toolCallId);
      p.resolve(this.pick(p.options, ["reject_once", "reject_always"]));
    } else if (response.decision === "allow-once") {
      p.resolve(this.pick(p.options, ["allow_once", "allow_always"]));
    } else {
      p.resolve(this.pick(p.options, ["allow_always", "allow_once"]));
    }
  }

  async setModel(model: string, reasoning?: string): Promise<void> {
    await this.setConfig("model", model);
    if (reasoning) await this.setConfig("thought_level", reasoning);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    await this.applyMode(mode);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const p of this.pending.values()) p.resolve({ outcome: { outcome: "cancelled" } });
    this.pending.clear();
    this.peer?.close();
    this.transport.kill();
  }
}
