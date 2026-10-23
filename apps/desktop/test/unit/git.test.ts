import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addWorktree,
  aheadCount,
  changedPaths,
  commitAll,
  currentBranch,
  diff,
  git,
  initRepo,
  merge,
  mergeConflicts,
  removeWorktree,
  repoRoot,
  restorePaths,
  revertHunk,
  setRef,
  snapshot,
  UnmergedError,
} from "../../src/main/git/git";

async function repo(files: Record<string, string> = { "README.md": "# r\n" }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "latis-git-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  await initRepo(dir);
  return dir;
}
const read = (dir: string, p: string) => readFileSync(join(dir, p), "utf8");
const staged = async (dir: string) => (await git(dir, ["diff", "--cached", "--name-only"])).stdout.trim();

describe("git service", () => {
  it("initialises a repo with a first commit and finds its root", async () => {
    const dir = await repo();
    mkdirSync(join(dir, "sub"));
    expect(await repoRoot(join(dir, "sub"))).toBe(await repoRoot(dir));
    expect(await currentBranch(dir)).toBeTruthy();
    expect(await repoRoot(tmpdir())).toBeNull();
  });

  it("snapshots tracked and untracked files without touching the index or HEAD", async () => {
    const dir = await repo({ "a.txt": "one\n", ".gitignore": "secret.env\n" });
    const head = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "fresh\n");
    writeFileSync(join(dir, "secret.env"), "KEY=1\n");
    await git(dir, ["add", "a.txt"]); // the user's own staging must survive
    const snap = await snapshot(dir, "checkpoint");
    expect((await git(dir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head);
    expect(await staged(dir)).toBe("a.txt");
    expect((await changedPaths(dir, head, snap)).sort()).toEqual(["a.txt", "new.txt"]);
  });

  it("restores a turn's files from a checkpoint, deleting files the turn created (undo/redo)", async () => {
    const dir = await repo({ "a.txt": "one\n" });
    const before = await snapshot(dir, "before");
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "b.txt"), "created\n");
    const after = await snapshot(dir, "after");
    await setRef(dir, "refs/latis/checkpoints/c/t-before", before);
    const files = await changedPaths(dir, before, after);
    await restorePaths(dir, before, files);
    expect(read(dir, "a.txt")).toBe("one\n");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    await restorePaths(dir, after, files);
    expect(read(dir, "a.txt")).toBe("two\n");
    expect(read(dir, "b.txt")).toBe("created\n");
    expect(await staged(dir)).toBe("");
  });

  it("diffs two snapshots into per-file hunks and reverts one hunk", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const dir = await repo({ "a.txt": lines.join("\n") + "\n" });
    const before = await snapshot(dir, "before");
    const edited = [...lines];
    edited[1] = "CHANGED 2";
    edited[17] = "CHANGED 18";
    writeFileSync(join(dir, "a.txt"), edited.join("\n") + "\n");
    writeFileSync(join(dir, "n.txt"), "new\n");
    const after = await snapshot(dir, "after");
    const files = await diff(dir, before, after);
    const a = files.find((f) => f.path === "a.txt")!;
    expect(a).toMatchObject({ change: "modified", additions: 2, deletions: 2 });
    expect(a.hunks).toHaveLength(2);
    expect(files.find((f) => f.path === "n.txt")).toMatchObject({ change: "created", additions: 1 });

    await revertHunk(dir, "a.txt", a.hunks[1]!, false);
    expect(read(dir, "a.txt")).toContain("CHANGED 2");
    expect(read(dir, "a.txt")).toContain("line 18");
    await revertHunk(dir, "n.txt", files.find((f) => f.path === "n.txt")!.hunks[0]!, true);
    expect(existsSync(join(dir, "n.txt"))).toBe(false);
  });

  it("runs a chat in a worktree, detects conflicts with a dry run, and merges", async () => {
    const dir = await repo({ "shared.txt": "base\n" });
    const base = (await currentBranch(dir))!;
    const wt1 = join(mkdtempSync(join(tmpdir(), "latis-wt-")), "one");
    const wt2 = join(mkdtempSync(join(tmpdir(), "latis-wt-")), "two");
    await addWorktree(dir, wt1, "latis/one", "HEAD");
    await addWorktree(dir, wt2, "latis/two", "HEAD");
    writeFileSync(join(wt1, "pricing.txt"), "pricing\n");
    writeFileSync(join(wt2, "checkout.txt"), "checkout\n");
    writeFileSync(join(wt2, "shared.txt"), "two's version\n");
    expect(await commitAll(wt1, "one")).toBe(true);
    expect(await commitAll(wt1, "nothing new")).toBe(false);
    await commitAll(wt2, "two");
    expect(await aheadCount(dir, base, "latis/one")).toBe(1);
    expect(await mergeConflicts(dir, base, "latis/one")).toEqual([]);
    await merge(dir, "latis/one", "merge", "Merge one");
    expect(read(dir, "pricing.txt")).toBe("pricing\n");

    // Main moves on and touches the same file: the dry run reports it without changing anything.
    writeFileSync(join(dir, "shared.txt"), "main's version\n");
    await commitAll(dir, "main edit");
    expect(await mergeConflicts(dir, base, "latis/two")).toEqual(["shared.txt"]);
    expect(read(dir, "shared.txt")).toBe("main's version\n");

    // Removal: a merged branch goes quietly; an unmerged one is refused before anything is deleted.
    await removeWorktree(dir, wt1, "latis/one", { base, deleteUnmerged: false });
    expect(existsSync(wt1)).toBe(false);
    await expect(removeWorktree(dir, wt2, "latis/two", { base, deleteUnmerged: false })).rejects.toThrow(UnmergedError);
    expect(existsSync(join(wt2, "checkout.txt"))).toBe(true);
    await removeWorktree(dir, wt2, "latis/two", { base, deleteUnmerged: true });
    expect(existsSync(wt2)).toBe(false);
  });
});
