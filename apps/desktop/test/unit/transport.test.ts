import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnTransport } from "../../src/main/agents/rpc/transport";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("spawnTransport", () => {
  it.skipIf(process.platform === "win32")("kills helpers the agent started, not just the agent (gemini re-launches itself)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lattiz-tree-"));
    const pidFile = join(dir, "child.pid");
    // A wrapper that spawns a long-lived child, like `gemini` re-launching with a bigger heap.
    writeFileSync(
      join(dir, "wrapper.cjs"),
      `const { spawn } = require("node:child_process");
       const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
       require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
       console.log("ready");
       setInterval(() => {}, 1000);`,
    );
    const t = spawnTransport({ file: process.execPath, args: [join(dir, "wrapper.cjs")], cwd: dir, env: process.env });
    await new Promise<void>((r) => t.onLine((l) => l === "ready" && r()));
    const child = Number(readFileSync(pidFile, "utf8"));
    expect(alive(child)).toBe(true);
    t.kill();
    await expect.poll(() => alive(child), { timeout: 3000 }).toBe(false);
  });
});
