import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Accounts } from "../../src/main/accounts";
import { openDb } from "../../src/main/store/db";
import { WorkspaceStore } from "../../src/main/store/workspace";

describe("Accounts", () => {
  it("points the active account's CLI at its own home folder, and forgets accounts without deleting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "latis-acc-"));
    const accounts = new Accounts(new WorkspaceStore(openDb(join(dir, "latis.db"))), dir);
    expect(accounts.env("claude-code")).toEqual({});
    const work = accounts.add("claude-code", " Work ");
    expect(work.label).toBe("Work");
    expect(existsSync(work.home)).toBe(true);
    expect(accounts.env("claude-code")).toEqual({}); // adding doesn't switch
    accounts.setActive("claude-code", work.id);
    expect(accounts.env("claude-code")).toEqual({ CLAUDE_CONFIG_DIR: work.home });
    expect(accounts.env("codex")).toEqual({});
    const cx = accounts.add("codex", "Team");
    expect(() => accounts.setActive("claude-code", cx.id)).toThrow(/another agent/);
    accounts.setActive("codex", cx.id);
    expect(accounts.env("codex")).toEqual({ CODEX_HOME: cx.home });
    accounts.remove(work.id);
    expect(accounts.env("claude-code")).toEqual({});
    expect(existsSync(work.home)).toBe(true);
    expect(() => accounts.add("terminal:aider", "x")).toThrow(/can't keep separate accounts/);
  });
});
