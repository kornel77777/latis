import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LineTransport } from "./transport";

// Test double for an agent process: replays recordings made by
// scripts/record-codex-stream.mjs / record-acp-stream.mjs ({dir: "in"|"out"|"restart", msg}).
// Each client message advances to the matching recorded "out" line, then the
// recorded "in" lines that followed it are played back until the next "out".
// So the replay pauses at every recorded approval until the app answers, like the real agent.

interface Line {
  dir: "in" | "out" | "restart";
  msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
}

export interface ReplayOptions {
  /** Recording used when a message names none. */
  fallback: string;
  /** The method that starts a turn; its text picks a recording by name, e.g. "please /edit-file". */
  turnMethod: string;
  /** Delay between played-back lines; 0 in unit tests. */
  paceMs?: number;
  /** Results for option-setting requests that weren't recorded here (e.g. a mode change). */
  stubs?: Record<string, unknown>;
  /** Only recordings whose name passes (one agent's recordings in a shared folder). */
  include?: (name: string) => boolean;
}

export class ReplayLibrary {
  readonly names: string[];
  constructor(
    private readonly dir: string,
    readonly opts: ReplayOptions,
  ) {
    this.names = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .filter((n) => opts.include?.(n) ?? true);
  }
  load(name: string, cwd: string): Line[] {
    return readFileSync(join(this.dir, `${name}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l.replaceAll("<cwd>", cwd)) as Line);
  }
}

function promptText(params: Record<string, unknown> | undefined): string {
  return JSON.stringify(params?.input ?? params?.prompt ?? "");
}

export function replayTransport(lib: ReplayLibrary, cwd: string): LineTransport {
  const listeners = new Set<(line: string) => void>();
  let rec = { name: lib.opts.fallback, lines: lib.load(lib.opts.fallback, cwd) };
  let i = 0;
  const ids = new Map<string, number | string>(); // recorded request id -> live request id
  let pumping = false;
  let killed = false;
  const pace = lib.opts.paceMs ?? 6;

  const findOut = (lines: Line[], from: number, method: string | undefined) => {
    for (let j = from; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.dir === "restart" && method !== undefined) return -1; // a recording's next process starts here
      if (l.dir === "out" && l.msg.method === method && (method !== undefined || l.msg.id !== undefined)) return j;
    }
    return -1;
  };

  /** Moves the cursor to the recorded line matching the client's message; "stub" answers it in place. */
  const seek = (m: Line["msg"]): number | "stub" | null => {
    const named = m.method === lib.opts.turnMethod ? lib.names.find((n) => promptText(m.params).includes(`/${n}`)) : undefined;
    if (named && named !== rec.name) rec = { name: named, lines: lib.load(named, cwd) };
    else if (!named) {
      const j = findOut(rec.lines, i, m.method);
      if (j >= 0) return j;
      if (m.method !== undefined && lib.opts.stubs && m.method in lib.opts.stubs) return "stub";
    }
    // Named recording, or nothing left here: take the first match from the top of a recording.
    const order = [rec.name, lib.opts.fallback, ...lib.names];
    for (const name of order) {
      const lines = name === rec.name ? rec.lines : lib.load(name, cwd);
      const j = lines.findIndex((l) => l.dir === "out" && l.msg.method === m.method && (m.method !== undefined || l.msg.id !== undefined));
      if (j >= 0) {
        rec = { name, lines };
        return j;
      }
    }
    return null;
  };

  const emit = (msg: Line["msg"]) => {
    let out = msg;
    if (msg.method === undefined && msg.id !== undefined) {
      const live = ids.get(String(msg.id));
      if (live === undefined) return; // a response to a request this run never made
      out = { ...msg, id: live };
    }
    const line = JSON.stringify(out);
    for (const fn of listeners) fn(line);
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!killed && i < rec.lines.length && rec.lines[i]!.dir === "in") {
        const line = rec.lines[i++]!;
        if (pace)
          await new Promise((r) =>
            setTimeout(r, line.msg.method?.endsWith("delta") || line.msg.method === "session/update" ? pace : pace * 3),
          );
        else await Promise.resolve();
        if (!killed) emit(line.msg);
      }
    } finally {
      pumping = false;
    }
  };

  return {
    send(line) {
      const m = JSON.parse(line) as Line["msg"];
      const j = seek(m);
      if (j === "stub") {
        const res = JSON.stringify({ id: m.id, result: lib.opts.stubs?.[m.method!] ?? null });
        if (m.id !== undefined) queueMicrotask(() => listeners.forEach((fn) => fn(res)));
        return;
      }
      if (j === null) {
        // Not in any recording: answer requests with "method not found" so callers fail fast.
        if (m.method !== undefined && m.id !== undefined) {
          const err = JSON.stringify({ id: m.id, error: { code: -32601, message: `not recorded: ${m.method}` } });
          queueMicrotask(() => listeners.forEach((fn) => fn(err)));
        }
        return;
      }
      const recorded = rec.lines[j]!.msg;
      if (m.method !== undefined && m.id !== undefined && recorded.id !== undefined) ids.set(String(recorded.id), m.id);
      i = j + 1;
      void pump();
    },
    onLine(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onExit() {
      return () => undefined;
    },
    kill() {
      killed = true;
    },
    stderrTail: () => "",
  };
}
