import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseUnifiedDiff, countChanges, type DiffHunk } from "@latis/shared";

// Thin wrapper over the user's `git` (SPEC §4: shell out; ≥ 2.38 for merge-tree dry runs).
// Nothing here touches the user's index, HEAD or branches except the explicit
// worktree/merge operations the user asks for.

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export interface FileDiff {
  path: string;
  /** For renames, the path before. */
  oldPath?: string;
  change: "created" | "modified" | "deleted";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
}

const ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
const AUTHOR = {
  GIT_AUTHOR_NAME: "Latis",
  GIT_AUTHOR_EMAIL: "latis@localhost",
  GIT_COMMITTER_NAME: "Latis",
  GIT_COMMITTER_EMAIL: "latis@localhost",
};

export function git(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; input?: string; okCodes?: number[] } = {},
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...ENV, ...opts.env }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        if (code === 0 || (code !== null && opts.okCodes?.includes(code))) resolve({ stdout, code });
        else reject(new GitError(`git ${args[0]} failed: ${stderr.trim() || err?.message}`, code, stderr));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

const out = async (cwd: string, args: string[], env?: Record<string, string>) => (await git(cwd, args, env ? { env } : {})).stdout.trim();

export async function gitVersion(): Promise<[number, number] | null> {
  try {
    const m = /(\d+)\.(\d+)/.exec(await out(process.cwd(), ["--version"]));
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    return null;
  }
}

/** The repository root containing `dir`, or null when it isn't in a git repo. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await out(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export async function headCommit(dir: string): Promise<string | null> {
  try {
    return await out(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    return null;
  }
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    return await out(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return null;
  }
}

/** `git init` plus a first commit of whatever is there (AC6 "Initialise git here"). */
export async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q"]);
  await git(dir, ["add", "-A"]);
  // The user's own identity when configured; Latis's otherwise, so the first commit can't fail.
  const hasIdentity = await out(dir, ["config", "user.email"]).catch(() => "");
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "Initial commit"], hasIdentity ? {} : { env: AUTHOR });
}

/**
 * Snapshots the working tree (tracked + untracked, minus ignored) as a commit object,
 * using a throwaway index so the user's staging area is untouched (§9.4 AC1).
 */
export async function snapshot(dir: string, message: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "latis-idx-"));
  const index = join(tmp, "index");
  try {
    const env = { GIT_INDEX_FILE: index, ...AUTHOR };
    const head = await headCommit(dir);
    // Start from a copy of the real index: its stat cache means only changed files get hashed.
    const realIndex = await out(dir, ["rev-parse", "--git-path", "index"]);
    const realPath = isAbsolute(realIndex) ? realIndex : join(dir, realIndex);
    if (existsSync(realPath)) copyFileSync(realPath, index);
    else if (head) await git(dir, ["read-tree", head], { env });
    await git(dir, ["add", "-A", "--", ":/"], { env });
    const tree = await out(dir, ["write-tree"], env);
    return await out(dir, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message], env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function setRef(dir: string, ref: string, commit: string): Promise<void> {
  await git(dir, ["update-ref", ref, commit]);
}

export async function deleteRefs(dir: string, prefix: string): Promise<void> {
  const refs = (await out(dir, ["for-each-ref", "--format=%(refname)", prefix])).split("\n").filter(Boolean);
  for (const r of refs) await git(dir, ["update-ref", "-d", r]);
}

/** Per-file diffs between two commits/trees. */
export async function diff(dir: string, from: string, to: string, paths: string[] = []): Promise<FileDiff[]> {
  const raw = await out(dir, ["diff", "--no-color", "--no-ext-diff", "-M", "--src-prefix=a/", "--dst-prefix=b/", from, to, "--", ...paths]);
  return parseGitDiff(raw);
}

export function parseGitDiff(raw: string): FileDiff[] {
  const files: FileDiff[] = [];
  for (const block of raw.split(/^diff --git /m).slice(1)) {
    const header = block.split("\n", 1)[0]!;
    const m = /^a\/(.+) b\/(.+)$/.exec(header);
    let oldPath = m?.[1] ?? "";
    let path = m?.[2] ?? "";
    const rename = /^rename from (.+)$/m.exec(block);
    const renameTo = /^rename to (.+)$/m.exec(block);
    if (rename && renameTo) {
      oldPath = rename[1]!;
      path = renameTo[1]!;
    }
    const change = /^new file mode/m.test(block) ? "created" : /^deleted file mode/m.test(block) ? "deleted" : "modified";
    const hunks = parseUnifiedDiff(block);
    files.push({
      path,
      ...(oldPath !== path && { oldPath }),
      change,
      hunks,
      ...countChanges(hunks),
      binary: /^Binary files /m.test(block),
    });
  }
  return files;
}

/** Files that differ between two commits. */
export async function changedPaths(dir: string, from: string, to: string): Promise<string[]> {
  return (await out(dir, ["diff", "--name-only", "--no-renames", from, to])).split("\n").filter(Boolean);
}

/**
 * Makes `paths` in the working tree match `commit` (deleting files the commit doesn't have).
 * Worktree only: the index and HEAD are untouched.
 */
export async function restorePaths(dir: string, commit: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const present = new Set((await out(dir, ["ls-tree", "-r", "--name-only", commit, "--", ...paths])).split("\n").filter(Boolean));
  const keep = paths.filter((p) => present.has(p));
  const gone = paths.filter((p) => !present.has(p));
  if (keep.length) await git(dir, ["restore", `--source=${commit}`, "--worktree", "--", ...keep]);
  for (const p of gone) rmSync(join(dir, p), { force: true });
}

/** Applies the reverse of one hunk to the working tree (§9.5 Revert hunk). Fails if the lines moved on. */
export async function revertHunk(dir: string, path: string, hunk: DiffHunk, created: boolean): Promise<void> {
  const header = created ? `--- /dev/null\n+++ b/${path}\n` : `--- a/${path}\n+++ b/${path}\n`;
  const body = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`;
  const patch = `diff --git a/${path} b/${path}\n${header}${body}`;
  const tmp = mkdtempSync(join(tmpdir(), "latis-patch-"));
  try {
    writeFileSync(join(tmp, "p.diff"), patch);
    await git(dir, ["apply", "-R", "--recount", "--whitespace=nowarn", join(tmp, "p.diff")]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── Worktrees (§9.3) ────────────────────────────────────────────────────────

export async function addWorktree(repo: string, path: string, branch: string, base: string): Promise<void> {
  await git(repo, ["worktree", "add", "-q", "-b", branch, path, base]);
}

/** Commits everything in a worktree on its branch (so merge sees it). Returns false if there was nothing. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ["add", "-A"]);
  const { code } = await git(dir, ["diff", "--cached", "--quiet"], { okCodes: [1] });
  if (code === 0) return false;
  const hasIdentity = await out(dir, ["config", "user.email"]).catch(() => "");
  await git(dir, ["commit", "-q", "-m", message], hasIdentity ? {} : { env: AUTHOR });
  return true;
}

/** Commits on `branch` that `base` doesn't have. */
export async function aheadCount(repo: string, base: string, branch: string): Promise<number> {
  return Number(await out(repo, ["rev-list", "--count", `${base}..${branch}`]));
}

/** Dry-run merge with `git merge-tree --write-tree` (git ≥ 2.38): conflicting paths, touching nothing. */
export async function mergeConflicts(repo: string, base: string, branch: string): Promise<string[]> {
  const { stdout, code } = await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, branch], { okCodes: [1] });
  if (code === 0) return [];
  // First line is the tree id; the rest are conflicted paths.
  return [...new Set(stdout.trim().split("\n").slice(1).filter(Boolean))];
}

export async function isClean(dir: string): Promise<boolean> {
  return (await out(dir, ["status", "--porcelain", "--untracked-files=no"])) === "";
}

export async function merge(repo: string, branch: string, mode: "merge" | "squash", message: string): Promise<void> {
  const hasIdentity = await out(repo, ["config", "user.email"]).catch(() => "");
  const env = hasIdentity ? {} : AUTHOR;
  if (mode === "squash") {
    await git(repo, ["merge", "--squash", branch], { env });
    await git(repo, ["commit", "-q", "-m", message], { env });
  } else {
    await git(repo, ["merge", "--no-ff", "-q", "-m", message, branch], { env });
  }
}

export class UnmergedError extends Error {
  constructor(readonly commits: number) {
    super(`The branch has ${commits} commit${commits === 1 ? "" : "s"} that ${commits === 1 ? "isn't" : "aren't"} merged.`);
  }
}

/**
 * Removes a worktree and its branch. Refuses before touching anything when the branch has
 * commits `base` doesn't, unless `deleteUnmerged` (the user confirmed, or it was squash-merged) (§9.3 AC5).
 */
export async function removeWorktree(
  repo: string,
  path: string,
  branch: string,
  opts: { base: string; deleteUnmerged: boolean },
): Promise<void> {
  if (!opts.deleteUnmerged) {
    const ahead = await aheadCount(repo, opts.base, branch).catch(() => 0);
    if (ahead > 0) throw new UnmergedError(ahead);
  }
  await git(repo, ["worktree", "remove", "--force", path]);
  await git(repo, ["branch", "-D", branch]);
}
