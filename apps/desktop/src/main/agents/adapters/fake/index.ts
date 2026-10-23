import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentAdapter, AgentEvent, AgentSession, SessionOptions } from "@latis/shared";
import { FromRunner, type ToRunner } from "./protocol";

export interface FakeAdapterOptions {
  /** Absolute path to the built fake-runner entry. */
  runnerPath: string;
  /** Script name → JSONL contents. Must include "demo". */
  scripts: Record<string, string>;
}

/** Scripted adapter used for tests and the demo agent (SPEC §6.6). */
export class FakeAdapter implements AgentAdapter {
  readonly id = "fake";
  readonly displayName = "Demo agent";
  readonly hue = "violet";
  readonly capabilities = {
    streaming: true,
    steering: false,
    images: false,
    resume: false,
    permissions: "native",
    plans: false,
    questions: false,
    subagents: false,
    mcp: false,
    reasoningLevels: false,
    usageReporting: true,
    nativeTerminal: false,
  } as const;

  constructor(private readonly opts: FakeAdapterOptions) {}

  async detect() {
    return { installed: true, version: "0.1.0" };
  }
  async authStatus() {
    return { signedIn: true, method: "none" as const };
  }
  async listModels() {
    return [{ id: "demo-1", label: "Demo 1" }];
  }
  terminalCommand(opts: SessionOptions) {
    return { file: process.env.SHELL ?? "/bin/sh", args: [], cwd: opts.cwd };
  }

  /** "/crash" or "/<script>" anywhere in the message picks that script. */
  pickScript(text: string): string {
    const m = /\/([a-z-]+)/.exec(text);
    const name = m?.[1];
    return name && name in this.opts.scripts ? this.opts.scripts[name]! : this.opts.scripts["demo"]!;
  }

  async startSession(opts: SessionOptions): Promise<AgentSession> {
    const child = spawn(process.execPath, [this.opts.runnerPath], {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
    });
    return new FakeSession(child, (t) => this.pickScript(t));
  }
}

class FakeSession implements AgentSession {
  readonly id = randomUUID();
  private listeners = new Set<(e: AgentEvent) => void>();
  private exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private disposed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly pickScript: (text: string) => string,
  ) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      const parsed = FromRunner.safeParse(safeJson(line));
      if (!parsed.success) {
        console.warn("[fake] dropped invalid line", line.slice(0, 200));
        return;
      }
      if (parsed.data.type === "event") for (const l of this.listeners) l(parsed.data.event);
    });
    child.stderr.on("data", (d: Buffer) => console.warn("[fake] stderr", d.toString().slice(0, 500)));
    child.on("exit", (code, signal) => {
      if (this.disposed) return;
      for (const l of this.exitListeners) l({ code, signal });
    });
    child.stdin.on("error", () => {
      /* child gone; exit handler reports it */
    });
  }

  private post(msg: ToRunner): void {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async send(turn: { text: string }) {
    this.post({ type: "turn", text: turn.text, script: this.pickScript(turn.text) });
  }
  async interrupt() {
    this.post({ type: "interrupt" });
  }
  async respond(requestId: string, response: Parameters<AgentSession["respond"]>[1]) {
    const allow = response.kind === "permission" ? response.decision !== "deny" : response.kind === "plan" ? response.approve : true;
    this.post({ type: "respond", requestId, decision: allow ? "allow" : "deny" });
  }
  onEvent(listener: (e: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onExit(listener: (info: { code: number | null; signal: string | null }) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  async dispose() {
    this.disposed = true;
    this.child.stdin.end();
    this.child.kill();
  }
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
