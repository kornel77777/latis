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
import { JsonRpcPeer, RpcError, type Params } from "../../rpc/peer";
import { spawnTransport, type LineTransport } from "../../rpc/transport";
import { SessionBase } from "../../session-base";
import { shellEnv, versionOf, which } from "../../shell-env";
import { CodexMapper, type CodexRequest } from "./mapper";

// Codex via `codex app-server` (SPEC §6.3, docs/adapters/codex.md).

type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
type Approval = "never" | "untrusted";
const MODES: Record<PermissionMode, { approvalPolicy: Approval; sandbox: Sandbox }> = {
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "auto-edit": { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "full-auto": { approvalPolicy: "never", sandbox: "danger-full-access" },
};
/** `turn/start` takes the sandbox as a policy object with every field set. */
function sandboxPolicy(sandbox: Sandbox) {
  if (sandbox === "read-only") return { type: "readOnly", networkAccess: false };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

interface CodexModel {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
}

export interface CodexAdapterOptions {
  /** Replaces the app-server process (tests replay recordings). */
  transport?: (cwd: string) => LineTransport;
  /** Overrides binary discovery (tests). */
  executable?: string | null;
}

const CLIENT_INFO = { name: "latis", title: "Latis", version: "0.1.0" };

async function connect(transport: LineTransport, handlers: ConstructorParameters<typeof JsonRpcPeer>[1]): Promise<JsonRpcPeer> {
  const peer = new JsonRpcPeer(transport, handlers, { jsonrpc: false });
  await peer.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
  peer.notify("initialized");
  return peer;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly hue = "slate-blue";
  readonly capabilities = {
    streaming: true,
    steering: true,
    images: true,
    resume: true,
    permissions: "native",
    plans: false,
    questions: true,
    subagents: true,
    mcp: true,
    reasoningLevels: true,
    usageReporting: true,
    nativeTerminal: true,
  } as const;
  readonly installHint = "npm install -g @openai/codex";

  private binary: Promise<string | null> | null = null;
  private models: ModelInfo[] | null = null;
  private auth: AuthStatus | null = null;

  constructor(private readonly opts: CodexAdapterOptions = {}) {}

  private executable(): Promise<string | null> {
    if (this.opts.executable !== undefined) return Promise.resolve(this.opts.executable);
    this.binary ??= which("codex");
    return this.binary;
  }

  refresh(): void {
    this.binary = null;
    this.models = null;
    this.auth = null;
  }

  async transport(cwd: string): Promise<LineTransport> {
    if (this.opts.transport) return this.opts.transport(cwd);
    const bin = await this.executable();
    if (!bin) throw new Error(`Codex isn't installed. Install it with: ${this.installHint}`);
    return spawnTransport({ file: bin, args: ["app-server"], cwd, env: await shellEnv() });
  }

  async detect(): Promise<DetectResult> {
    const bin = await this.executable();
    if (!bin) return { installed: false };
    const version = this.opts.transport ? "test" : await versionOf(bin);
    return { installed: true, binaryPath: bin, ...(version && { version }) };
  }

  /** Starts an app-server without a thread (no tokens spent) and runs `fn` against it. */
  private async probe<T>(fn: (peer: JsonRpcPeer) => Promise<T>): Promise<T> {
    const transport = await this.transport(process.cwd());
    const peer = await connect(transport, {
      request: () => Promise.reject(new RpcError("not supported", -32601)),
      notification: () => undefined,
    });
    try {
      return await fn(peer);
    } finally {
      peer.close();
      transport.kill();
    }
  }

  async authStatus(): Promise<AuthStatus> {
    if (this.auth) return this.auth;
    try {
      const res = await this.probe((p) =>
        p.request<{ account: { type: "chatgpt"; email?: string; planType?: string } | { type: "apiKey" } | null }>("account/read", {
          refreshToken: false,
        }),
      );
      const acc = res.account;
      this.auth = !acc
        ? { signedIn: false, method: "none" }
        : acc.type === "apiKey"
          ? { signedIn: true, method: "api-key" }
          : { signedIn: true, method: "subscription", ...(acc.email && { account: acc.email }) };
    } catch (err) {
      console.warn("[codex] auth probe failed", err);
      this.auth = { signedIn: false, method: "none" };
    }
    return this.auth;
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.models) return this.models;
    const res = await this.probe((p) => p.request<{ data: CodexModel[] }>("model/list", {}));
    const visible = res.data.filter((m) => !m.hidden);
    const toInfo = (m: CodexModel): ModelInfo => ({
      id: m.id,
      label: m.displayName,
      ...(m.description && { description: m.description }),
      reasoningLevels: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    });
    const def = visible.find((m) => m.isDefault);
    // "default" lets a chat follow Codex's own default model (the user's config.toml).
    this.models = [...(def ? [{ ...toInfo(def), id: "default", label: `Default (${def.displayName})` }] : []), ...visible.map(toInfo)];
    return this.models;
  }

  async login(): Promise<LoginHandle> {
    const bin = (await this.executable()) ?? "codex";
    return { pty: { file: bin, args: ["login"], cwd: process.cwd() }, done: Promise.resolve({ signedIn: false }) };
  }

  terminalCommand(opts: SessionOptions & { nativeSessionId?: string }) {
    return { file: "codex", args: opts.nativeSessionId ? ["resume", opts.nativeSessionId] : [], cwd: opts.cwd };
  }

  startSession(opts: SessionOptions): Promise<AgentSession> {
    return CodexSession.open(this, opts, undefined);
  }

  resumeSession(nativeSessionId: string, opts: SessionOptions): Promise<AgentSession> {
    return CodexSession.open(this, opts, nativeSessionId);
  }
}

interface PendingRequest {
  req: CodexRequest;
  resolve: (result: unknown) => void;
}

class CodexSession extends SessionBase implements AgentSession {
  private peer!: JsonRpcPeer;
  private mapper: CodexMapper;
  private threadId = "";
  private activeTurn: string | null = null;
  private interrupting = false;
  private pending = new Map<string, PendingRequest>();
  private mode: PermissionMode;
  private model: string | undefined;
  private effort: string | undefined;
  /** Options changed since the last turn/start; sent with the next one. */
  private dirty = { mode: false, model: false };
  private disposed = false;

  private constructor(
    private readonly transport: LineTransport,
    opts: SessionOptions,
  ) {
    super();
    this.mapper = new CodexMapper(opts.cwd);
    this.mode = opts.permissionMode;
    this.model = opts.model && opts.model !== "default" ? opts.model : undefined;
    this.effort = opts.reasoning;
  }

  static async open(adapter: CodexAdapter, opts: SessionOptions, resume: string | undefined): Promise<CodexSession> {
    const transport = await adapter.transport(opts.cwd);
    const s = new CodexSession(transport, opts);
    transport.onExit((info) => {
      if (s.disposed) return;
      for (const p of s.pending.values()) p.resolve({ decision: "cancel" });
      s.pending.clear();
      s.peer?.close("Codex exited");
      s.exit(info);
    });
    try {
      s.peer = await connect(transport, {
        request: (method, params) => s.onRequest(method, params),
        notification: (method, params) => s.onNotification(method, params),
      });
      const base = { cwd: opts.cwd, ...MODES[opts.permissionMode], ...(s.model && { model: s.model }) };
      const res = resume
        ? await s.peer.request<{ thread: { id: string }; model: string }>("thread/resume", {
            threadId: resume,
            ...base,
            excludeTurns: true,
          })
        : await s.peer.request<{ thread: { id: string }; model: string }>("thread/start", base);
      s.threadId = res.thread.id;
      s.emit({ type: "session.started", nativeSessionId: res.thread.id, model: res.model });
      return s;
    } catch (err) {
      transport.kill();
      const detail = transport.stderrTail().split("\n").filter(Boolean).at(-1);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(detail && !msg.includes(detail) ? `${msg} (${detail})` : msg, { cause: err });
    }
  }

  private onNotification(method: string, params: Params): void {
    if (params.threadId !== undefined && params.threadId !== this.threadId) return;
    if (method === "turn/started") this.activeTurn = (params.turn as { id: string }).id;
    if (method === "turn/completed") {
      this.activeTurn = null;
      if (this.interrupting) {
        this.interrupting = false;
        (params.turn as { status: string }).status = "interrupted";
      }
    }
    for (const e of this.mapper.notification(method, params)) this.emit(e);
  }

  private onRequest(method: string, params: Params): Promise<unknown> {
    const req = this.mapper.request(method, params);
    if (!req) return Promise.reject(new RpcError(`Latis doesn't support ${method} yet`, -32601));
    // Latis-side auto-answers that make the modes behave as documented (codex.md → Permission modes).
    if (req.event.type === "permission.requested") {
      if (req.pureRead && this.mode !== "read-only") return Promise.resolve({ decision: "accept" });
      if (req.editInsideCwd && this.mode === "auto-edit") return Promise.resolve({ decision: "accept" });
      if (this.mode === "full-auto") return Promise.resolve({ decision: "accept" });
      if (this.mode === "read-only") return Promise.resolve({ decision: "decline" });
    }
    return new Promise((resolve) => {
      this.pending.set(req.requestId, { req, resolve });
      this.emit(req.event);
    });
  }

  private turnOverrides() {
    const o: Record<string, unknown> = {};
    if (this.dirty.mode) {
      o.approvalPolicy = MODES[this.mode].approvalPolicy;
      o.sandboxPolicy = sandboxPolicy(MODES[this.mode].sandbox);
    }
    if (this.model) o.model = this.model;
    if (this.effort) o.effort = this.effort;
    this.dirty = { mode: false, model: false };
    return o;
  }

  async send(turn: UserTurn): Promise<void> {
    const input = [
      ...(turn.images ?? []).map((img) => ({ type: "image", url: `data:${img.mime};base64,${img.dataBase64}` })),
      { type: "text", text: turn.text, text_elements: [] },
    ];
    const res = await this.peer.request<{ turn: { id: string } }>("turn/start", {
      threadId: this.threadId,
      input,
      ...this.turnOverrides(),
    });
    this.activeTurn ??= res.turn.id;
  }

  async steer(text: string): Promise<void> {
    if (!this.activeTurn) throw new Error("No turn is running");
    await this.peer.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurn,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interrupt(): Promise<void> {
    for (const p of this.pending.values()) p.resolve({ decision: "cancel" });
    this.pending.clear();
    if (!this.activeTurn) return;
    this.interrupting = true;
    await this.peer.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurn });
  }

  async respond(requestId: string, response: RequestResponse): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (response.kind === "permission") {
      const decision = response.decision === "deny" ? "decline" : response.decision === "allow-once" ? "accept" : "acceptForSession";
      p.resolve({ decision });
    } else if (response.kind === "answer") {
      const ids = p.req.questionIds ?? {};
      const answers = Object.fromEntries(
        Object.entries(response.answers ?? {}).map(([question, label]) => [ids[question] ?? question, { answers: label.split(", ") }]),
      );
      p.resolve({ answers });
    } else {
      p.resolve({ decision: response.approve ? "accept" : "decline" });
    }
  }

  async setModel(model: string, reasoning?: string): Promise<void> {
    this.model = model === "default" ? undefined : model;
    this.effort = reasoning;
    this.dirty.model = true;
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.mode = mode;
    this.dirty.mode = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const p of this.pending.values()) p.resolve({ decision: "cancel" });
    this.pending.clear();
    this.peer?.close();
    this.transport.kill();
  }
}
