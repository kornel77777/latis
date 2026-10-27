import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  EffortLevel,
  HookCallback,
  McpHttpServerConfig,
  McpStdioServerConfig,
  Options,
  PermissionMode as SdkPermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKUserMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import {
  matchAlwaysAsk,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type AuthStatus,
  type DetectResult,
  type LoginHandle,
  type McpServerConfig,
  type ModelInfo,
  type PermissionMode,
  type RequestResponse,
  type SessionOptions,
  type UserTurn,
} from "@lattiz/shared";
import { agentEnv, versionOf, which } from "../../shell-env";
import { ClaudeMapper, toolKind } from "./mapper";

export type QueryFn = typeof sdkQuery;

const SDK_MODE: Record<PermissionMode, SdkPermissionMode> = {
  "read-only": "default",
  ask: "default",
  "auto-edit": "acceptEdits",
  "full-auto": "bypassPermissions",
};
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const READ_ONLY_KINDS = new Set(["read", "search", "web"]);
/** Tools whose `command` input runs in a shell, checked against the always-ask list. */
const SHELL_TOOLS = "Bash|PowerShell";
/** Tools that are conversations with the user, not actions, so read-only mode still lets them through. */
const DIALOG_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

function sdkMcp(m: McpServerConfig): McpStdioServerConfig | McpHttpServerConfig {
  return m.transport === "http"
    ? { type: "http", url: m.url!, ...(m.headers && { headers: m.headers }) }
    : { type: "stdio", command: m.command!, args: m.args ?? [], ...(m.env && { env: m.env }) };
}

/** The workspace tools carry their own guardrails in Lattiz, so they don't ask the user each time. */
const isWorkspaceTool = (name: string) => name.startsWith("mcp__lattiz__");

export interface ClaudeAdapterOptions {
  /** Injected in tests to replay recorded streams. */
  queryFn?: QueryFn;
  /** Overrides binary discovery (tests). */
  executable?: string | null;
  /** The user's Anthropic API key, when one is saved (Settings → Agents). */
  apiKey?: () => string | null;
  /**
   * Whether the chat view may run on the user's own Claude sign-in. Anthropic doesn't allow third-party products
   * to offer that (DECISIONS 2026-10-26), so release builds need an API key; personal and dev builds may.
   */
  subscription?: boolean;
}

export const NEEDS_API_KEY =
  "The Claude chat view needs an Anthropic API key (Settings → Agents → Claude). To use your Claude subscription, start a Claude Code chat instead: it runs in a terminal.";

/** Claude Code via the Claude Agent SDK, drawn as Lattiz's chat card (SPEC §6.3, docs/adapters/claude-code.md). */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code";
  // Anthropic's branding rules for Agent SDK products: "Claude", not "Claude Code".
  readonly displayName = "Claude";
  readonly hue = "amber-sand";
  readonly capabilities = {
    streaming: true,
    steering: true,
    images: true,
    resume: true,
    permissions: "native",
    plans: true,
    questions: true,
    subagents: true,
    mcp: true,
    reasoningLevels: true,
    usageReporting: true,
    nativeTerminal: true,
  } as const;
  readonly installHint = "npm install -g @anthropic-ai/claude-code";

  private binary: Promise<string | null> | null = null;
  private models: ModelInfo[] | null = null;
  private auth: AuthStatus | null = null;

  constructor(private readonly opts: ClaudeAdapterOptions = {}) {}

  private async queryFn(): Promise<QueryFn> {
    return this.opts.queryFn ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
  }

  private executable(): Promise<string | null> {
    if (this.opts.executable !== undefined) return Promise.resolve(this.opts.executable);
    this.binary ??= which("claude");
    return this.binary;
  }

  /** Forget cached discovery so Settings → Agents can re-check after an install or sign-in. */
  refresh(): void {
    this.binary = null;
    this.models = null;
    this.auth = null;
  }

  async detect(): Promise<DetectResult> {
    const bin = await this.executable();
    if (!bin) return { installed: false };
    const version = this.opts.queryFn ? "test" : await versionOf(bin);
    return { installed: true, binaryPath: bin, ...(version && { version }) };
  }

  /**
   * The API key as env (saved in Lattiz, else ANTHROPIC_API_KEY from the user's shell), or nothing to run on the
   * user's sign-in where that's allowed. Null when neither is available.
   */
  private async credentials(): Promise<Record<string, string> | null> {
    const key = this.opts.apiKey?.() ?? (await agentEnv(this.id)).ANTHROPIC_API_KEY;
    if (key) return { ANTHROPIC_API_KEY: key };
    return this.opts.subscription ? {} : null;
  }

  /** Starts the CLI without sending a message (no tokens spent) and runs `fn` against it. */
  private async probe<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    const bin = await this.executable();
    if (!bin) throw new Error("Claude Code is not installed");
    const input = new InputQueue();
    const q = (await this.queryFn())({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: bin,
        env: { ...(await agentEnv(this.id)), ...(await this.credentials()) },
        persistSession: false,
      },
    });
    try {
      return await fn(q);
    } finally {
      input.end();
      q.close();
    }
  }

  async authStatus(): Promise<AuthStatus> {
    if (this.auth) return this.auth;
    if (!(await this.credentials())) return { signedIn: false, method: "none" };
    try {
      const info = await this.probe((q) => q.accountInfo());
      const apiKey = info.apiKeySource && info.apiKeySource !== "none";
      this.auth = {
        signedIn: Boolean(info.email || info.tokenSource || apiKey),
        ...(info.email && { account: info.email }),
        method: apiKey ? "api-key" : info.email || info.tokenSource ? "subscription" : "none",
      };
    } catch (err) {
      console.warn("[claude-code] auth probe failed", err);
      this.auth = { signedIn: false, method: "none" };
    }
    return this.auth;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.models) return this.models;
    const raw = await this.probe((q) => q.supportedModels());
    this.models = raw.map((m) => ({
      id: m.value,
      label: m.displayName,
      ...(m.description && { description: m.description }),
      ...(m.supportsEffort && m.supportedEffortLevels && { reasoningLevels: m.supportedEffortLevels }),
    }));
    return this.models;
  }

  /** `claude auth login` in a terminal; Lattiz never touches Claude's credential files (§6.5). */
  async login(): Promise<LoginHandle> {
    const bin = (await this.executable()) ?? "claude";
    return { pty: { file: bin, args: ["auth", "login"], cwd: process.cwd() }, done: Promise.resolve({ signedIn: false }) };
  }

  terminalCommand(opts: SessionOptions & { nativeSessionId?: string }) {
    return { file: "claude", args: opts.nativeSessionId ? ["--resume", opts.nativeSessionId] : [], cwd: opts.cwd };
  }

  startSession(opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, undefined);
  }

  resumeSession(nativeSessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return this.open(opts, nativeSessionId);
  }

  private async open(opts: SessionOptions, resume: string | undefined): Promise<AgentSession> {
    const bin = await this.executable();
    if (!bin) throw new Error(`Claude Code isn't installed. Install it with: ${this.installHint}`);
    const credentials = await this.credentials();
    if (!credentials) throw new Error(NEEDS_API_KEY);
    return new ClaudeSession(
      await this.queryFn(),
      bin,
      { ...process.env, ...(await agentEnv(this.id)), ...opts.env, ...credentials },
      opts,
      resume,
    );
  }
}

/** Async-iterable message queue feeding the SDK's streaming input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private done = false;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    this.wake?.();
  }
  end(): void {
    this.done = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

interface Pending {
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

class ClaudeSession implements AgentSession {
  readonly id = randomUUID();
  nativeSessionId?: string;
  private listeners = new Set<(e: AgentEvent) => void>();
  private exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private pending = new Map<string, Pending>();
  private input = new InputQueue();
  private mapper: ClaudeMapper;
  private q: Query;
  private disposed = false;
  private mode: PermissionMode;
  private alwaysAsk: string[];

  constructor(queryFn: QueryFn, executable: string, env: NodeJS.ProcessEnv, opts: SessionOptions, resume: string | undefined) {
    this.mode = opts.permissionMode;
    this.alwaysAsk = opts.alwaysAsk;
    this.mapper = new ClaudeMapper(opts.cwd);
    if (resume) this.nativeSessionId = resume;
    const options: Options = {
      cwd: opts.cwd,
      pathToClaudeCodeExecutable: executable,
      env,
      includePartialMessages: true,
      permissionMode: SDK_MODE[opts.permissionMode],
      thinking: { type: "adaptive", display: "summarized" },
      canUseTool: this.canUseTool,
      // canUseTool isn't consulted in bypassPermissions, so the always-ask list runs as a PreToolUse hook (§9.8 AC3).
      hooks: { PreToolUse: [{ matcher: SHELL_TOOLS, timeout: 7 * 24 * 3600, hooks: [this.preToolUse] }] },
      ...(opts.model && opts.model !== "default" && { model: opts.model }),
      ...(opts.reasoning && EFFORTS.has(opts.reasoning) && { effort: opts.reasoning as EffortLevel }),
      // Lets the chat switch into Full-auto later; the starting mode is still the one above.
      allowDangerouslySkipPermissions: true,
      ...(opts.systemPromptAppend && { systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemPromptAppend } }),
      ...(opts.mcpServers?.length && { mcpServers: Object.fromEntries(opts.mcpServers.map((m) => [m.name, sdkMcp(m)])) }),
      ...(resume && { resume }),
    };
    this.q = queryFn({ prompt: this.input, options });
    void this.consume();
  }

  private emit(e: AgentEvent): void {
    if (e.type === "session.started" && e.nativeSessionId) this.nativeSessionId = e.nativeSessionId;
    for (const l of this.listeners) l(e);
  }

  private async consume(): Promise<void> {
    try {
      for await (const m of this.q) for (const e of this.mapper.map(m)) this.emit(e);
      if (!this.disposed) this.exit(0, null);
    } catch (err) {
      if (this.disposed) return;
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err), recoverable: false });
      this.exit(1, null);
    }
  }

  private exit(code: number | null, signal: string | null): void {
    for (const p of this.pending.values()) p.resolve({ behavior: "deny", message: "Session ended." });
    this.pending.clear();
    for (const l of this.exitListeners) l({ code, signal });
  }

  private canUseTool: CanUseTool = (toolName, input, opts) => {
    if (this.mode === "read-only" && !DIALOG_TOOLS.has(toolName) && !READ_ONLY_KINDS.has(toolKind(toolName))) {
      this.mapper.markDenied(opts.toolUseID);
      return Promise.resolve({ behavior: "deny", message: "This chat is read-only in Lattiz. Describe the change instead of making it." });
    }
    if (isWorkspaceTool(toolName)) return Promise.resolve({ behavior: "allow", updatedInput: input });
    const event = this.mapper.requestEvent(toolName, input, {
      toolUseID: opts.toolUseID,
      ...(opts.title !== undefined && { title: opts.title }),
      ...(opts.displayName !== undefined && { displayName: opts.displayName }),
      ...(opts.decisionReason !== undefined && { decisionReason: opts.decisionReason }),
    });
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(opts.toolUseID, { toolName, input, suggestions: opts.suggestions ?? [], resolve });
      opts.signal.addEventListener("abort", () => {
        this.pending.delete(opts.toolUseID);
        resolve({ behavior: "deny", message: "Cancelled." });
      });
      this.emit(event);
    });
  };

  /**
   * Commands on the always-ask list wait for the user in every mode. The hook's allow/deny skips the agent's own
   * permission check, so a matching command is asked about once (docs/adapters/claude-code.md → Always-ask list).
   */
  private preToolUse: HookCallback = (input, _toolUseID, { signal }) => {
    if (input.hook_event_name !== "PreToolUse" || this.mode === "read-only") return Promise.resolve({});
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const pattern = typeof toolInput.command === "string" ? matchAlwaysAsk(toolInput.command, this.alwaysAsk) : null;
    if (!pattern) return Promise.resolve({});
    const id = input.tool_use_id;
    const event = { ...this.mapper.requestEvent(input.tool_name, toolInput, { toolUseID: id }), alwaysAsk: pattern };
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { toolName: input.tool_name, input: toolInput, suggestions: [], resolve });
      signal.addEventListener("abort", () => {
        this.pending.delete(id);
        resolve({ behavior: "deny", message: "Cancelled." });
      });
      this.emit(event);
    }).then((r) => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: r.behavior,
        permissionDecisionReason: r.behavior === "deny" ? r.message : `The user approved this (always-ask: ${pattern}).`,
      },
    }));
  };

  async send(turn: UserTurn): Promise<void> {
    const content: SDKUserMessage["message"]["content"] = turn.images?.length
      ? [
          ...turn.images.map((img) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: img.mime as "image/png", data: img.dataBase64 },
          })),
          { type: "text" as const, text: turn.text },
        ]
      : turn.text;
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  /** Delivered at the model's next step without stopping the turn (`priority: "next"`, docs/adapters/claude-code.md). */
  async steer(text: string): Promise<void> {
    this.input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority: "next" });
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (response.kind === "permission") {
      if (response.decision === "deny") {
        this.mapper.markDenied(requestId);
        p.resolve({ behavior: "deny", message: response.reason ? `The user denied this: ${response.reason}` : "The user denied this." });
        return;
      }
      // "Always" rules stay in this session; Claude's own suggestions would write into the repo's settings file.
      const always = response.decision !== "allow-once";
      p.resolve({
        behavior: "allow",
        updatedInput: p.input,
        ...(always && { updatedPermissions: p.suggestions.map((s) => ({ ...s, destination: "session" as const })) }),
      });
    } else if (response.kind === "answer") {
      p.resolve({ behavior: "allow", updatedInput: { ...p.input, answers: response.answers ?? {} } });
    } else if (response.approve) {
      p.resolve({ behavior: "allow", updatedInput: p.input });
    } else {
      this.mapper.markDenied(requestId);
      p.resolve({ behavior: "deny", message: response.feedback ? `Keep planning. Feedback: ${response.feedback}` : "Keep planning." });
    }
  }

  async interrupt(): Promise<void> {
    this.mapper.markInterrupting();
    for (const [id, p] of this.pending) {
      this.mapper.markDenied(id);
      p.resolve({ behavior: "deny", message: "Interrupted by the user.", interrupt: true });
    }
    this.pending.clear();
    await this.q.interrupt();
  }

  async setModel(model: string, reasoning?: string): Promise<void> {
    await this.q.setModel(model === "default" ? undefined : model);
    if (reasoning && EFFORTS.has(reasoning)) await this.q.applyFlagSettings({ effortLevel: reasoning as EffortLevel });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    await this.q.setPermissionMode(SDK_MODE[mode]);
  }

  setAlwaysAsk(patterns: string[]): void {
    this.alwaysAsk = patterns;
  }

  onEvent(listener: (e: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (info: { code: number | null; signal: string | null }) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.input.end();
    this.q.close();
  }
}
