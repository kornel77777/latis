import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { IPty } from "node-pty";
import type { PtyInfo } from "@lattiz/shared";

// Terminals for the dock and terminal-only agents (SPEC §9.6). PTYs live in the main
// process, so they survive canvas switches and renderer reloads; the renderer repaints
// from `snapshot()` when a view remounts.

export interface PtySpawn {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  title: string;
  projectId: string | null;
  chatId: string | null;
  place: PtyInfo["place"];
  cols?: number;
  rows?: number;
}

export interface PtySinks {
  data(id: string, data: string): void;
  exit(id: string, code: number | null): void;
}

interface Entry {
  info: PtyInfo;
  proc: IPty;
  /** Scrollback for repaints, trimmed to SNAPSHOT_MAX. */
  snapshot: string;
  pending: string;
  shell: string;
  listeners: Set<(e: { data?: string; input?: string; exit?: number | null }) => void>;
}

const SNAPSHOT_MAX = 256 * 1024;
const FLUSH_MS = 16;

export type PtyModule = typeof import("node-pty");

export class PtyManager {
  private ptys = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pty: () => Promise<PtyModule>,
    private readonly sinks: PtySinks,
  ) {}

  async create(spec: PtySpawn): Promise<PtyInfo> {
    const { spawn } = await this.pty();
    const proc = spawn(spec.file, spec.args, {
      name: "xterm-256color",
      cols: spec.cols ?? 100,
      rows: spec.rows ?? 30,
      cwd: spec.cwd,
      env: { ...spec.env, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Lattiz" } as Record<string, string>,
    });
    const id = randomUUID();
    const entry: Entry = {
      info: { id, title: spec.title, cwd: spec.cwd, projectId: spec.projectId, chatId: spec.chatId, place: spec.place, running: true },
      proc,
      snapshot: "",
      pending: "",
      shell: basename(spec.file),
      listeners: new Set(),
    };
    this.ptys.set(id, entry);
    proc.onData((data) => {
      entry.snapshot = (entry.snapshot + data).slice(-SNAPSHOT_MAX);
      entry.pending += data;
      entry.listeners.forEach((l) => l({ data }));
      this.schedule();
    });
    proc.onExit(({ exitCode }) => {
      this.flush();
      entry.info = { ...entry.info, running: false };
      entry.listeners.forEach((l) => l({ exit: exitCode }));
      this.sinks.exit(id, exitCode);
    });
    return entry.info;
  }

  private schedule() {
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const [id, e] of this.ptys) {
      if (!e.pending) continue;
      const data = e.pending;
      e.pending = "";
      this.sinks.data(id, data);
    }
  }

  get(id: string): PtyInfo | undefined {
    return this.ptys.get(id)?.info;
  }

  list(): PtyInfo[] {
    return [...this.ptys.values()].map((e) => e.info);
  }

  forChat(chatId: string): PtyInfo | undefined {
    return [...this.ptys.values()].find((e) => e.info.chatId === chatId && e.info.running)?.info;
  }

  snapshot(id: string): string {
    return this.ptys.get(id)?.snapshot ?? "";
  }

  write(id: string, data: string): boolean {
    const e = this.ptys.get(id);
    if (!e?.info.running) return false;
    e.proc.write(data);
    e.listeners.forEach((l) => l({ input: data }));
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const e = this.ptys.get(id);
    if (!e?.info.running) return false;
    try {
      e.proc.resize(cols, rows);
    } catch {
      return false; // the process exited between the check and the call
    }
    return true;
  }

  /** Kills a running terminal, or forgets one that already exited (closing its tab). */
  kill(id: string): boolean {
    const e = this.ptys.get(id);
    if (!e) return false;
    if (e.info.running) e.proc.kill();
    else this.ptys.delete(id);
    return true;
  }

  subscribe(id: string, fn: (e: { data?: string; input?: string; exit?: number | null }) => void): () => void {
    const e = this.ptys.get(id);
    e?.listeners.add(fn);
    return () => e?.listeners.delete(fn);
  }

  /** Terminals running something other than their idle shell, for the quit warning (§9.6 AC3). */
  busy(): PtyInfo[] {
    return [...this.ptys.values()]
      .filter((e) => e.info.running && e.proc.process && basename(e.proc.process) !== e.shell)
      .map((e) => e.info);
  }

  disposeAll(): void {
    for (const e of this.ptys.values()) if (e.info.running) e.proc.kill();
    this.ptys.clear();
  }
}
