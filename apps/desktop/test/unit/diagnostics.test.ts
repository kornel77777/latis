import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentInfo } from "@latis/shared";
import { diagnostics, issueUrl, ISSUES_NEW } from "../../src/main/diagnostics";
import { LogFile, scrub } from "../../src/main/logs";

describe("scrub", () => {
  it("removes home paths, tokens, keys and emails", () => {
    const line = `Failed in /Users/kim/code/app: Authorization: Bearer 0123456789abcdef0123 key sk-ant-api03-ABCDEFGHIJKLMNOP api_key=hunter2hunter2 for kim@example.com`;
    expect(scrub(line, "/Users/kim")).toBe(
      "Failed in ~/code/app: Authorization: Bearer [token] key sk-[key] api_key=[redacted] for [email]",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(scrub("[supervisor] checkpoint failed: not a git repository", "/Users/kim")).toBe(
      "[supervisor] checkpoint failed: not a git repository",
    );
  });
});

describe("LogFile", () => {
  it("appends scrubbed lines and returns the tail", () => {
    const log = new LogFile(mkdtempSync(join(tmpdir(), "latis-logs-")));
    log.write("warn", ["token=abc123def456"]);
    log.write("error", [new Error("boom")]);
    const text = readFileSync(log.file, "utf8");
    expect(text).toContain("[warn] token=[redacted]");
    expect(text).toContain("[error] Error: boom");
    expect(log.tail(50)).toMatch(/\[error\] Error: boom/);
    expect(log.tail(1)).not.toContain("[warn]");
  });

  it("rotates past 1 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "latis-logs-"));
    const log = new LogFile(dir);
    writeFileSync(log.file, "x".repeat(1024 * 1024 + 1));
    log.write("warn", ["fresh"]);
    expect(readFileSync(log.file, "utf8")).toMatch(/\[warn\] fresh\n$/);
    expect(readFileSync(join(dir, "latis.1.log"), "utf8").length).toBe(1024 * 1024 + 1);
  });
});

const agent = (over: Partial<AgentInfo>): AgentInfo => ({
  id: "codex",
  displayName: "Codex",
  hue: "sky",
  installed: true,
  signedIn: true,
  unenforceable: [],
  kind: "structured",
  steering: true,
  canSignIn: true,
  source: "built-in",
  ...over,
});

describe("diagnostics", () => {
  it("lists the version, OS and installed agents, and scrubs the log tail", () => {
    const text = diagnostics({
      version: "0.1.0",
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.0.0",
      electron: "45.0.0",
      agents: [
        agent({ version: "0.164.0" }),
        agent({ id: "terminal:claude", displayName: "Claude Code", kind: "terminal" }),
        agent({ id: "gemini", displayName: "Gemini CLI", installed: false }),
        agent({ id: "fake", displayName: "Demo agent" }),
      ],
      logTail: "2026-10-26T00:00:00Z [warn] Bearer abcdefabcdefabcdef",
    });
    expect(text).toContain("Latis 0.1.0 · darwin 25.0.0 (arm64) · Electron 45.0.0");
    expect(text).toContain("- Codex 0.164.0: structured, ready");
    expect(text).toContain("- Claude Code: terminal, ready");
    expect(text).not.toContain("Gemini");
    expect(text).not.toContain("Demo agent");
    expect(text).toContain("Bearer [token]");
  });

  it("opens a new issue with only the version and OS filled in", () => {
    const url = new URL(issueUrl("0.1.0", "darwin 25.0.0"));
    expect(`${url.origin}${url.pathname}`).toBe(ISSUES_NEW);
    const body = url.searchParams.get("body")!;
    expect(body).toContain("Latis 0.1.0 on darwin 25.0.0");
    expect(body).not.toContain("[warn]");
  });
});
