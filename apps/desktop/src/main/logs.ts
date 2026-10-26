import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";

// Local diagnostics (docs/privacy.md): warnings and errors from the main process go to <dataDir>/logs/latis.log,
// scrubbed of home paths, tokens and keys. Nothing is sent anywhere; "Report a problem" copies the tail for the
// user to paste themselves.

const MAX_BYTES = 1024 * 1024;

/** Removes what shouldn't leave the machine from a log line. */
export function scrub(text: string, home = homedir()): string {
  let out = text;
  if (home) out = out.split(home).join("~");
  return out
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1[token]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "sk-[key]")
    .replace(/\b(api[_-]?key|token|secret|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}

export class LogFile {
  readonly file: string;

  constructor(private readonly dir: string) {
    this.file = join(dir, "latis.log");
  }

  write(level: "warn" | "error", args: unknown[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      if (existsSync(this.file) && statSync(this.file).size > MAX_BYTES) renameSync(this.file, join(this.dir, "latis.1.log"));
      appendFileSync(this.file, `${new Date().toISOString()} [${level}] ${scrub(format(...args))}\n`);
    } catch {
      // Logging must never break the app.
    }
  }

  /** The last `lines` lines, for "Report a problem". */
  tail(lines = 60): string {
    try {
      return readFileSync(this.file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  /** Mirrors console.warn/error into the file, and records crashes of the main process. */
  install(): void {
    for (const level of ["warn", "error"] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        original(...args);
        this.write(level, args);
      };
    }
    process.on("uncaughtException", (err) => this.write("error", ["[main] uncaught", err]));
    process.on("unhandledRejection", (err) => this.write("error", ["[main] unhandled rejection", err]));
  }
}
