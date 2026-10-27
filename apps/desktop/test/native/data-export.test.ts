import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { exportWorkspace } from "../../src/main/data-export";
import { openDb } from "../../src/main/store/db";
import { WorkspaceStore } from "../../src/main/store/workspace";

describe("exportWorkspace", () => {
  it("copies the workspace without secrets, sign-ins, tokens or the browser profile", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lattiz-data-"));
    const store = new WorkspaceStore(openDb(join(dataDir, "lattiz.db")));
    store.setSetting("claudeApiKey", "ZW5jcnlwdGVk");
    store.setSetting("prefs", { checkUpdates: true });
    const sqlite = new Database(join(dataDir, "lattiz.db"));
    sqlite
      .prepare("INSERT INTO mcp_servers (id, name, transport, args_json, secret, shared, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("m1", "github", "http", "[]", Buffer.from("secret-bytes"), 0, Date.now());
    sqlite.close();
    for (const [dir, file] of [
      ["skills", "review.md"],
      ["cards/c1", "index.html"],
      ["accounts/claude-code/work", ".credentials.json"],
      ["run", "claude-c1-hooks.json"],
      ["electron", "Cookies"],
    ] as const) {
      mkdirSync(join(dataDir, dir), { recursive: true });
      writeFileSync(join(dataDir, dir, file), "x");
    }

    const target = mkdtempSync(join(tmpdir(), "lattiz-export-"));
    const out = exportWorkspace(dataDir, target, new Date(2026, 9, 26, 9, 5));
    expect(out).toBe(join(target, "Lattiz export 2026-10-26 0905"));
    expect(exportWorkspace(dataDir, target, new Date(2026, 9, 26, 9, 5))).toBe(`${out} (2)`);

    expect(existsSync(join(out, "skills", "review.md"))).toBe(true);
    expect(existsSync(join(out, "cards", "c1", "index.html"))).toBe(true);
    for (const left of ["accounts", "run", "electron"]) expect(existsSync(join(out, left))).toBe(false);
    expect(readFileSync(join(out, "README.txt"), "utf8")).toContain("Secrets were removed");

    const copy = new Database(join(out, "lattiz.db"), { readonly: true });
    expect(copy.prepare("SELECT key FROM settings ORDER BY key").all()).toEqual([{ key: "prefs" }]);
    expect(copy.prepare("SELECT name, secret FROM mcp_servers").all()).toEqual([{ name: "github", secret: null }]);
    copy.close();
  });
});
