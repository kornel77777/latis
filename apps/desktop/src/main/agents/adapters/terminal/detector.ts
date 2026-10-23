// Infers a terminal-only agent's state from its output (SPEC §6.3):
// working while output flows; idle after 1.5 s of silence (and a prompt match when the
// manifest gives a prompt regex); needs-you when recent output looks like an approval prompt.

export type TerminalState = "idle" | "working" | "needs-you";

export const DEFAULT_APPROVAL = /\(y\/n\)|\[y\/n\]|\(yes\/no\)|\bAllow\b|\bApprove\b|Do you want to (proceed|run|allow|make)/i;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g; // eslint-disable-line no-control-regex
/** Output this soon after a keystroke, and this short, is the terminal echoing the user. */
const ECHO_MS = 200;
const ECHO_MAX = 200;
const RECENT_MAX = 4096;

export function stripAnsi(s: string): string {
  return s.replace(/\r(?!\n)/g, "\n").replace(ANSI, "");
}

export class StatusDetector {
  state: TerminalState = "idle";
  private recent = "";
  private lastActivity = 0;
  private lastInput = -Infinity;

  constructor(private readonly opts: { promptRegex?: RegExp; approvalRegex?: RegExp; idleMs?: number } = {}) {}

  /** The last non-empty output line, for the Inbox. */
  lastLine(): string {
    const lines = this.recent
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const line = lines.at(-1) ?? "";
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }

  private tail(lines = 6): string {
    return this.recent.split("\n").slice(-lines).join("\n");
  }

  /** The user typed. Answering an approval puts the agent back to work. */
  input(at: number): TerminalState | null {
    this.lastInput = at;
    if (this.state === "needs-you") return this.set("working", at);
    return null;
  }

  data(chunk: string, at: number): TerminalState | null {
    this.recent = (this.recent + stripAnsi(chunk)).slice(-RECENT_MAX);
    if (at - this.lastInput < ECHO_MS && chunk.length < ECHO_MAX) return null;
    this.lastActivity = at;
    if ((this.opts.approvalRegex ?? DEFAULT_APPROVAL).test(this.tail())) return this.set("needs-you", at);
    return this.state === "needs-you" ? null : this.set("working", at);
  }

  /** Called on a timer; returns the new state when silence makes the agent idle. */
  tick(at: number): TerminalState | null {
    if (this.state !== "working" || at - this.lastActivity < (this.opts.idleMs ?? 1500)) return null;
    if (this.opts.promptRegex && !this.opts.promptRegex.test(this.lastLine())) return null;
    return this.set("idle", at);
  }

  private set(state: TerminalState, at: number): TerminalState | null {
    if (state === this.state) return null;
    this.state = state;
    if (state === "working") this.lastActivity = at;
    return state;
  }
}
