import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** A newline-delimited message channel to an agent process (or a replay of one). */
export interface LineTransport {
  send(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  /** Fires once when the process exits on its own (not after `kill`). */
  onExit(listener: (info: { code: number | null; signal: string | null }) => void): () => void;
  kill(): void;
  /** Last lines the process wrote to stderr, for error messages. */
  stderrTail(): string;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const STDERR_LINES = 20;

export function spawnTransport(spec: SpawnSpec): LineTransport {
  const child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    // Windows needs a shell to run npm-installed `.cmd` shims.
    shell: process.platform === "win32",
  });
  const lineListeners = new Set<(line: string) => void>();
  const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  const stderr: string[] = [];
  let killed = false;

  createInterface({ input: child.stdout }).on("line", (l) => lineListeners.forEach((fn) => fn(l)));
  createInterface({ input: child.stderr }).on("line", (l) => {
    stderr.push(l);
    if (stderr.length > STDERR_LINES) stderr.shift();
  });
  const exit = (code: number | null, signal: string | null) => {
    if (killed) return;
    killed = true;
    exitListeners.forEach((fn) => fn({ code, signal }));
  };
  child.on("exit", (code, signal) => exit(code, signal));
  child.on("error", (err) => {
    stderr.push(err.message);
    exit(null, null);
  });
  // A dead pipe surfaces through "exit"; don't let EPIPE crash the main process.
  child.stdin.on("error", () => undefined);

  return {
    send: (line) => {
      if (!killed) child.stdin.write(line + "\n");
    },
    onLine: (fn) => {
      lineListeners.add(fn);
      return () => lineListeners.delete(fn);
    },
    onExit: (fn) => {
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    kill: () => {
      killed = true;
      child.kill();
    },
    stderrTail: () => stderr.join("\n"),
  };
}
