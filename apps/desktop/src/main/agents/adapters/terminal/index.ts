import type {
  AgentAdapter,
  AgentCapabilities,
  AgentSession,
  DetectResult,
  LoginHandle,
  ModelInfo,
  SessionOptions,
  UserTurn,
} from "@latis/shared";
import type { AgentManifest } from "../../manifests";
import { SessionBase } from "../../session-base";
import { shellEnv, versionOf, which } from "../../shell-env";
import type { PtyManager } from "../../../terminal/pty-manager";
import { StatusDetector } from "./detector";

// Any CLI agent run raw in a PTY (SPEC §6.3 terminal-only). The terminal is the UI;
// Latis only infers working / idle / needs-you from the output.

const TICK_MS = 500;

export class TerminalAdapter implements AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly hue: string;
  readonly installHint: string | undefined;
  readonly capabilities: AgentCapabilities = {
    streaming: false,
    steering: false,
    images: false,
    resume: false,
    permissions: "none",
    plans: false,
    questions: false,
    subagents: false,
    mcp: false,
    reasoningLevels: false,
    usageReporting: false,
    nativeTerminal: true,
  };

  private binary: Promise<string | null> | null = null;

  constructor(
    readonly manifest: AgentManifest,
    protected readonly ptys: PtyManager,
    private readonly opts: { executable?: string | null } = {},
  ) {
    this.id = manifest.id;
    this.displayName = manifest.displayName;
    this.hue = manifest.hue;
    this.installHint = manifest.installHint;
  }

  protected executablePath(): Promise<string | null> {
    if (this.opts.executable !== undefined) return Promise.resolve(this.opts.executable);
    this.binary ??= which(this.manifest.command);
    return this.binary;
  }

  refresh(): void {
    this.binary = null;
  }

  async detect(): Promise<DetectResult> {
    const bin = await this.executablePath();
    if (!bin) return { installed: false };
    const version = await versionOf(bin, this.manifest.detect.versionArgs);
    return { installed: true, binaryPath: bin, ...(version && { version }) };
  }

  /** Terminal agents handle sign-in inside their own UI. */
  async authStatus() {
    return { signedIn: true, method: "none" as const };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async login(): Promise<LoginHandle> {
    const bin = (await this.executablePath()) ?? this.manifest.command;
    return { pty: { file: bin, args: this.manifest.login?.args ?? [], cwd: process.cwd() }, done: Promise.resolve({ signedIn: true }) };
  }

  terminalCommand(opts: SessionOptions) {
    return { file: this.manifest.command, args: this.manifest.args, cwd: opts.cwd };
  }

  async startSession(opts: SessionOptions): Promise<AgentSession> {
    const bin = await this.executablePath();
    if (!bin) throw new Error(`${this.displayName} isn't installed.${this.installHint ? ` Install it with: ${this.installHint}` : ""}`);
    const info = await this.ptys.create({
      file: bin,
      args: this.manifest.args,
      cwd: opts.cwd,
      env: { ...(await shellEnv()), ...opts.env },
      title: this.displayName,
      projectId: null,
      chatId: opts.chatId ?? null,
      place: "chat",
    });
    const detector = new StatusDetector({
      ...(this.manifest.promptRegex && { promptRegex: new RegExp(this.manifest.promptRegex, "m") }),
      ...(this.manifest.approvalRegex && { approvalRegex: new RegExp(this.manifest.approvalRegex, "i") }),
    });
    return new TerminalSession(this.ptys, info.id, detector, this.displayName);
  }
}

class TerminalSession extends SessionBase implements AgentSession {
  private timer: NodeJS.Timeout;
  private unsub: () => void;

  constructor(
    private readonly ptys: PtyManager,
    readonly ptyId: string,
    private readonly detector: StatusDetector,
    name: string,
  ) {
    super();
    queueMicrotask(() => this.emit({ type: "session.started", model: name }));
    this.unsub = ptys.subscribe(ptyId, (e) => {
      const now = Date.now();
      if (e.input !== undefined) this.report(detector.input(now));
      if (e.data !== undefined) this.report(detector.data(e.data, now));
      if (e.exit !== undefined) {
        clearInterval(this.timer);
        // A clean exit (the user quit the agent) isn't a crash; the card offers to start it again.
        if (e.exit === 0) this.report(detector.state === "idle" ? null : "idle", "Exited");
        else this.exit({ code: e.exit, signal: null });
      }
    });
    this.timer = setInterval(() => this.report(detector.tick(Date.now())), TICK_MS);
  }

  private report(state: ReturnType<StatusDetector["tick"]>, detail = this.detector.lastLine()) {
    if (state) this.emit({ type: "agent.status", status: state, ...(detail && { detail }) });
  }

  /** Messages from Latis (Inbox, queue) are typed into the terminal. */
  async send(turn: UserTurn): Promise<void> {
    this.ptys.write(this.ptyId, turn.text + "\r");
  }

  async interrupt(): Promise<void> {
    this.ptys.write(this.ptyId, "\x03");
  }

  async respond(): Promise<void> {
    // Approvals are answered in the terminal itself (permissions: "none").
  }

  async dispose(): Promise<void> {
    clearInterval(this.timer);
    this.unsub();
    this.ptys.kill(this.ptyId);
  }
}
