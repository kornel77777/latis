import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  matchAlwaysAsk,
  type AgentCapabilities,
  type AgentEvent,
  type AgentSession,
  type McpServerConfig,
  type RequestResponse,
  type SessionOptions,
  type UserTurn,
} from "@latis/shared";
import type { HookEndpoint } from "../../../mcp/server";
import type { PtyManager } from "../../../terminal/pty-manager";
import type { AgentManifest } from "../../manifests";
import { SessionBase } from "../../session-base";
import { agentEnv } from "../../shell-env";
import { TerminalAdapter } from "../terminal";
import { ClaudeMapper } from "./mapper";

// Claude Code in its own terminal UI, on the user's own sign-in (docs/adapters/claude-code.md → Terminal).
// Latis starts `claude` with an extra settings file whose HTTP hooks report to Latis: status, turns,
// approvals (answered in the terminal or in Latis, whichever is first) and the always-ask list.

export const CLAUDE_TERMINAL_MANIFEST: AgentManifest = {
  id: "terminal:claude",
  displayName: "Claude Code",
  protocol: "terminal",
  command: "claude",
  args: [],
  detect: { versionArgs: ["--version"] },
  login: { args: ["auth", "login"] },
  hue: "amber-sand",
  installHint: "npm install -g @anthropic-ai/claude-code",
};

/** Hook events Latis listens to. A user's own hooks keep running next to these. */
const EVENTS = ["UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop"] as const;
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
/** Hooks wait while the user decides; Claude Code's limit is per hook, in seconds. */
const HOOK_TIMEOUT_SEC = 7 * 24 * 3600;
/** After Esc or Ctrl+C mid-turn with no further hook, the turn counts as interrupted. */
const INTERRUPT_GRACE_MS = 2500;

export interface ClaudeTerminalOptions {
  /** Latis's hook endpoint, once its server is listening. */
  endpoint: () => Promise<HookEndpoint>;
  /** Where per-session settings files (they hold tokens) are written. */
  runDir: string;
  executable?: string | null;
}

/** Claude Code's `--mcp-config` shape. */
function mcpConfig(servers: McpServerConfig[]) {
  return {
    mcpServers: Object.fromEntries(
      servers.map((m) => [
        m.name,
        m.transport === "http"
          ? { type: "http", url: m.url, ...(m.headers && { headers: m.headers }) }
          : { type: "stdio", command: m.command, args: m.args ?? [], ...(m.env && { env: m.env }) },
      ]),
    ),
  };
}

/** Writes a file only this user can read (it carries tokens). */
function writePrivate(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export class ClaudeTerminalAdapter extends TerminalAdapter {
  override readonly capabilities: AgentCapabilities = {
    streaming: false,
    steering: false,
    images: false,
    resume: true,
    permissions: "native",
    plans: false,
    questions: false,
    subagents: true,
    mcp: true,
    reasoningLevels: false,
    usageReporting: false,
    nativeTerminal: true,
  };

  constructor(
    ptys: PtyManager,
    private readonly claude: ClaudeTerminalOptions,
  ) {
    super(CLAUDE_TERMINAL_MANIFEST, ptys, claude.executable !== undefined ? { executable: claude.executable } : {});
  }

  override terminalCommand(opts: SessionOptions & { nativeSessionId?: string }) {
    return { file: "claude", args: opts.nativeSessionId ? ["--resume", opts.nativeSessionId] : [], cwd: opts.cwd };
  }

  override startSession(opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, randomUUID(), false);
  }

  resumeSession(nativeSessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, nativeSessionId, true);
  }

  private async open(opts: SessionOptions, sessionId: string, resume: boolean): Promise<AgentSession> {
    const bin = await this.executablePath();
    if (!bin) throw new Error(`Claude Code isn't installed. Install it with: ${CLAUDE_TERMINAL_MANIFEST.installHint}`);
    const chatId = opts.chatId ?? sessionId;
    const endpoint = await this.claude.endpoint();
    mkdirSync(this.claude.runDir, { recursive: true });
    const settingsFile = join(this.claude.runDir, `claude-${chatId}-hooks.json`);
    const hook = {
      hooks: [
        {
          type: "http",
          url: endpoint.hookUrl,
          timeout: HOOK_TIMEOUT_SEC,
          headers: { Authorization: `Bearer ${endpoint.hookTokenFor(chatId)}` },
        },
      ],
    };
    writePrivate(settingsFile, { hooks: Object.fromEntries(EVENTS.map((e) => [e, [hook]])) });
    const files = [settingsFile];
    const args = [resume ? "--resume" : "--session-id", sessionId, "--settings", settingsFile];
    if (opts.mcpServers?.length) {
      const mcpFile = join(this.claude.runDir, `claude-${chatId}-mcp.json`);
      writePrivate(mcpFile, mcpConfig(opts.mcpServers));
      files.push(mcpFile);
      args.push("--mcp-config", mcpFile);
    }
    if (opts.systemPromptAppend) args.push("--append-system-prompt", opts.systemPromptAppend);
    // Accounts (Settings → Agents) are shared with the chat-view Claude: same CLI home.
    const env = { ...(await agentEnv("claude-code")), ...opts.env };
    const info = await this.ptys.create({
      file: bin,
      args,
      cwd: opts.cwd,
      env,
      title: this.displayName,
      projectId: null,
      chatId: opts.chatId ?? null,
      place: "chat",
    });
    const session = new ClaudeTerminalSession(this.ptys, info.id, sessionId, opts, resume, () => {
      unregister();
      for (const f of files) rmSync(f, { force: true });
    });
    const unregister = endpoint.onHook(chatId, (input) => session.onHook(input));
    return session;
  }
}

type Pending =
  { kind: "pre"; resolve: (out: unknown) => void } | { kind: "permission"; suggestions: unknown[]; resolve: (out: unknown) => void };

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export class ClaudeTerminalSession extends SessionBase implements AgentSession {
  private pending = new Map<string, Pending>();
  private mapper: ClaudeMapper;
  private alwaysAsk: string[];
  private turnStart: number | null = null;
  /** Text Latis typed for the user (queue, Inbox); its prompt hook doesn't start a second turn. */
  private typed: string | null = null;
  private status: "working" | "idle" | "needs-you" | null = null;
  private interruptTimer: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private unsub: () => void;

  constructor(
    private readonly ptys: PtyManager,
    readonly ptyId: string,
    sessionId: string,
    private readonly opts: SessionOptions,
    private readonly resuming: boolean,
    private readonly cleanup: () => void,
  ) {
    super();
    this.mapper = new ClaudeMapper(opts.cwd);
    this.alwaysAsk = opts.alwaysAsk;
    this.nativeSessionId = sessionId;
    // After the caller has subscribed (startSession resolves first), so the id gets stored for resuming.
    setTimeout(() => this.emit({ type: "session.started", nativeSessionId: sessionId, model: "Claude Code" }), 0);
    this.unsub = ptys.subscribe(ptyId, (e) => {
      if (e.input !== undefined && this.turnStart !== null && (e.input === "\x1b" || e.input === "\x03")) this.armInterrupt();
      if (e.exit !== undefined) this.onPtyExit(e.exit ?? 1);
    });
  }

  private setStatus(status: "working" | "idle" | "needs-you", detail?: string) {
    if (this.status === status && !detail) return;
    this.status = status;
    this.emit({ type: "agent.status", status, ...(detail && { detail }) });
  }

  private armInterrupt() {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => this.endTurn("interrupted"), INTERRUPT_GRACE_MS);
  }

  private endTurn(status: "ok" | "interrupted") {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    if (this.turnStart === null) return;
    const durationMs = Date.now() - this.turnStart;
    this.turnStart = null;
    this.status = null;
    this.emit({ type: "turn.completed", status, durationMs });
  }

  /** Requests still open when another hook arrives were answered in the terminal. */
  private settleStale(keep?: string) {
    for (const [id, p] of this.pending) {
      if (id === keep) continue;
      this.pending.delete(id);
      p.resolve({});
    }
  }

  private ask(id: string, event: AgentEvent, p: Pending): Promise<unknown> {
    const answered = new Promise<unknown>((resolve) => {
      p.resolve = resolve;
    });
    this.pending.set(id, p);
    this.status = "needs-you";
    this.emit(event);
    return answered;
  }

  async onHook(input: Record<string, unknown>): Promise<unknown> {
    const event = str(input.hook_event_name);
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    if (event !== "PermissionRequest") this.settleStale();
    const toolName = str(input.tool_name) ?? "";
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    switch (event) {
      case "UserPromptSubmit": {
        const prompt = str(input.prompt) ?? "";
        if (this.turnStart !== null) this.endTurn("interrupted");
        // Latis records the turn and takes its checkpoint before Claude sees the prompt.
        if (this.typed !== null && prompt.trim() === this.typed.trim()) this.typed = null;
        else await this.opts.onUserTurn?.(prompt);
        this.turnStart = Date.now();
        this.setStatus("working");
        return {};
      }
      case "PreToolUse": {
        this.setStatus("working");
        const command = str(toolInput.command);
        const pattern = SHELL_TOOLS.has(toolName) && command ? matchAlwaysAsk(command, this.alwaysAsk) : null;
        if (!pattern) return {};
        const id = str(input.tool_use_id) ?? randomUUID();
        const request = { ...this.mapper.requestEvent(toolName, toolInput, { toolUseID: id }), alwaysAsk: pattern };
        const answer = (await this.ask(id, request, { kind: "pre", resolve: () => undefined })) as RequestResponse | Record<string, never>;
        if (!("kind" in answer)) return {};
        const allow = answer.kind === "permission" && answer.decision !== "deny";
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: allow ? "allow" : "deny",
            permissionDecisionReason: allow
              ? `The user approved this in Latis (always-ask: ${pattern}).`
              : answer.kind === "permission" && answer.reason
                ? `The user denied this in Latis: ${answer.reason}`
                : "The user denied this in Latis.",
          },
        };
      }
      case "PermissionRequest": {
        // Claude Code shows its own prompt as well; whichever is answered first wins.
        const id = `perm-${randomUUID()}`;
        const request = this.mapper.requestEvent(toolName, toolInput, { toolUseID: id });
        if (request.type !== "permission.requested") return {};
        const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : [];
        const answer = (await this.ask(id, request, { kind: "permission", suggestions, resolve: () => undefined })) as
          RequestResponse | Record<string, never>;
        if (!("kind" in answer) || answer.kind !== "permission") return {};
        const decision =
          answer.decision === "deny"
            ? {
                behavior: "deny",
                message: answer.reason ? `The user denied this in Latis: ${answer.reason}` : "The user denied this in Latis.",
              }
            : {
                behavior: "allow",
                // "Always" stays in this session, like the chat view; suggestions would otherwise write to the repo.
                ...(answer.decision !== "allow-once" &&
                  suggestions.length && {
                    updatedPermissions: suggestions.map((s) => ({ ...(s as object), destination: "session" })),
                  }),
              };
        return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
      }
      case "PostToolUse":
        this.setStatus("working");
        return {};
      case "Notification": {
        const type = str(input.notification_type);
        // Approvals arrive as PermissionRequest; the idle reminder means nothing is running.
        if (type === "idle_prompt" && this.turnStart === null) this.setStatus("idle");
        else if (type && type !== "permission_prompt" && type !== "idle_prompt") this.setStatus("needs-you", str(input.message));
        return {};
      }
      case "Stop": {
        const last = str(input.last_assistant_message);
        if (last?.trim()) this.emit({ type: "message.completed", text: last });
        this.endTurn("ok");
        return {};
      }
      default:
        return {};
    }
  }

  private onPtyExit(code: number) {
    this.settleStale();
    this.unsub();
    this.cleanup();
    // A resume that dies at once means the conversation is gone: the supervisor starts fresh next time.
    if (this.resuming && code !== 0 && Date.now() - this.startedAt < 10_000) {
      this.emit({ type: "turn.completed", status: "error", durationMs: 0 });
      return;
    }
    this.endTurn("interrupted");
    if (code === 0) this.emit({ type: "agent.status", status: "idle", detail: "Exited" });
    else this.exit({ code, signal: null });
  }

  /** Messages from Latis (queue, Inbox, flows) are typed into Claude Code's prompt. */
  async send(turn: UserTurn): Promise<void> {
    this.typed = turn.text;
    this.ptys.write(this.ptyId, turn.text);
    // Claude Code treats a paste-sized burst ending in Enter as a newline; send Enter on its own.
    setTimeout(() => this.ptys.write(this.ptyId, "\r"), 150);
  }

  async interrupt(): Promise<void> {
    this.ptys.write(this.ptyId, "\x1b");
    this.armInterrupt();
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    // An event after the request marks it answered in the transcript (and the terminal tile's banner).
    this.status = null;
    this.setStatus("working");
    p.resolve(response);
  }

  setAlwaysAsk(patterns: string[]): void {
    this.alwaysAsk = patterns;
  }

  async dispose(): Promise<void> {
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.settleStale();
    this.unsub();
    this.cleanup();
    this.ptys.kill(this.ptyId);
  }
}
