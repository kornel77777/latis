import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
let cached: Promise<NodeJS.ProcessEnv> | null = null;

/**
 * The user's login-shell environment. GUI apps on macOS start with a minimal
 * PATH, so agent CLIs installed via Homebrew, npm or installers aren't found
 * without this. Falls back to process.env on Windows or on any failure.
 */
export function shellEnv(): Promise<NodeJS.ProcessEnv> {
  cached ??= withAgentPath(loginEnv());
  return cached;
}

/** LATIS_AGENT_PATH (dev/test): extra folders searched first for agent CLIs. */
async function withAgentPath(env: Promise<NodeJS.ProcessEnv>): Promise<NodeJS.ProcessEnv> {
  const e = await env;
  const extra = process.env.LATIS_AGENT_PATH;
  return extra ? { ...e, PATH: `${extra}${process.platform === "win32" ? ";" : ":"}${e.PATH ?? ""}` } : e;
}

function loginEnv(): Promise<NodeJS.ProcessEnv> {
  return (async () => {
    if (process.platform === "win32") return process.env;
    const shell = process.env.SHELL || "/bin/zsh";
    const marker = "__LATIS_ENV__";
    try {
      const { stdout } = await run(shell, ["-ilc", `printf '${marker}'; env; printf '${marker}'`], {
        timeout: 8000,
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      });
      const body = stdout.split(marker)[1] ?? "";
      const env: NodeJS.ProcessEnv = {};
      for (const line of body.split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
      }
      return env.PATH ? { ...process.env, ...env } : process.env;
    } catch (err) {
      console.warn("[shell-env] falling back to process env", err);
      return process.env;
    }
  })();
}

/** Resolves a command on the login-shell PATH. */
export async function which(command: string): Promise<string | null> {
  const env = await shellEnv();
  const finder = process.platform === "win32" ? "where" : "/usr/bin/which";
  try {
    const { stdout } = await run(finder, [command], { env, timeout: 4000 });
    return stdout.split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

export async function versionOf(binary: string, args = ["--version"]): Promise<string | undefined> {
  try {
    const { stdout } = await run(binary, args, { env: await shellEnv(), timeout: 8000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}
