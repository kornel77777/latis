import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { FileDiff, MergePreview, ReviewDecisions, ReviewItem, TimelineEntry } from "@latis/shared";
import type { WorkspaceStore } from "../store/workspace";
import {
  addWorktree,
  aheadCount,
  changedPaths,
  commitAll,
  currentBranch,
  diff,
  git,
  gitVersion,
  headCommit,
  initRepo,
  isClean,
  merge,
  mergeConflicts,
  removeWorktree,
  repoRoot,
  restorePaths,
  revertHunk,
  setRef,
  snapshot,
  UnmergedError,
} from "./git";

// Safe changes (SPEC §9.3–9.5): checkpoints around every turn, undo/redo/restore, review items,
// and per-chat worktrees with dry-run merges. Every git command runs from the repo root.

export interface ChangeSinks {
  reviews(items: ReviewItem[]): void;
  timeline(chatId: string, entries: TimelineEntry[]): void;
  /** A note the agent should read with the user's next message (files were reverted under it). */
  note(chatId: string, text: string): void;
  /** Sends a message to the chat as if the user typed it (Ask for changes, resolve conflicts). */
  message(chatId: string, text: string): Promise<void>;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "chat";

const list = (paths: string[]) => paths.map((p) => `\`${p}\``).join(", ");

export class Changes {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly dataDir: string,
    private readonly sinks: ChangeSinks,
  ) {}

  private chat(chatId: string) {
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    return chat;
  }

  // ── Checkpoints (§9.4) ──────────────────────────────────────────────────

  /** Snapshots the chat's repo before a turn. Folders that aren't git repos simply get no checkpoints. */
  async beforeTurn(chatId: string, turnId: string): Promise<void> {
    const chat = this.store.getChat(chatId);
    if (!chat) return;
    const repo = await repoRoot(chat.cwd);
    if (!repo) return;
    const before = await snapshot(repo, `Latis checkpoint before turn ${turnId}`);
    // Refs keep the snapshot commits alive through `git gc`.
    await setRef(repo, `refs/latis/checkpoints/${chatId}/${turnId}/before`, before);
    this.store.addCheckpoint({ chatId, turnId, repo, before });
  }

  /** Snapshots after the turn; a turn that changed files becomes a Review Inbox item (§9.5 AC1). */
  async afterTurn(chatId: string, turnId: string, finalMessage: string | undefined): Promise<void> {
    const cp = this.store.checkpoint(turnId);
    if (!cp || cp.after) return;
    const after = await snapshot(cp.repo, `Latis checkpoint after turn ${turnId}`);
    await setRef(cp.repo, `refs/latis/checkpoints/${chatId}/${turnId}/after`, after);
    const files = await changedPaths(cp.repo, cp.before, after);
    this.store.finishCheckpoint(turnId, after, files);
    if (files.length) {
      const stats = (await diff(cp.repo, cp.before, after)).map(({ path, change, additions, deletions }) => ({
        path,
        change,
        additions,
        deletions,
      }));
      const summary =
        (finalMessage ?? "").trim().split("\n").filter(Boolean).slice(0, 2).join("\n") ||
        `Changed ${files.length} file${files.length === 1 ? "" : "s"}`;
      this.store.addReview({ chatId, turnId, summary, files: stats });
      this.sinks.reviews(this.store.listReviews());
    }
    this.sinks.timeline(chatId, this.timeline(chatId));
  }

  timeline(chatId: string): TimelineEntry[] {
    const cps = new Map(this.store.chatCheckpoints(chatId).map((c) => [c.turnId, c]));
    return this.store.turns(chatId).map((t) => {
      const cp = cps.get(t.id);
      return {
        turnId: t.id,
        seq: t.seq,
        userText: t.userText,
        startedAt: t.startedAt,
        files: cp?.files ?? [],
        undone: Boolean(cp?.undoneAt),
        restorable: Boolean(cp?.after),
      };
    });
  }

  private finished(turnId: string) {
    const cp = this.store.checkpoint(turnId);
    if (!cp?.after) throw new Error("This turn has no checkpoint. Checkpoints need the folder to be a git repository.");
    return cp as typeof cp & { after: string };
  }

  async undo(chatId: string, turnId: string): Promise<TimelineEntry[]> {
    const cp = this.finished(turnId);
    if (!cp.undoneAt && cp.files.length) {
      await restorePaths(cp.repo, cp.before, cp.files);
      this.store.setUndone(turnId, true);
      this.sinks.note(chatId, `The user undid one of your turns. These files are back to how they were before it: ${list(cp.files)}.`);
    }
    return this.refresh(chatId);
  }

  async redo(chatId: string, turnId: string): Promise<TimelineEntry[]> {
    const cp = this.finished(turnId);
    if (cp.undoneAt) {
      await restorePaths(cp.repo, cp.after, cp.files);
      this.store.setUndone(turnId, false);
      this.sinks.note(chatId, `The user re-applied a turn they had undone. These files have your changes again: ${list(cp.files)}.`);
    }
    return this.refresh(chatId);
  }

  /** Puts every file this chat changed from `turnId` on back the way it was before that turn. */
  async restoreTo(chatId: string, turnId: string): Promise<TimelineEntry[]> {
    const target = this.finished(turnId);
    const later = this.store.chatCheckpoints(chatId).filter((c) => c.createdAt >= target.createdAt && !c.undoneAt);
    const files = [...new Set(later.flatMap((c) => c.files))];
    await restorePaths(target.repo, target.before, files);
    for (const c of later) this.store.setUndone(c.turnId, true);
    if (files.length)
      this.sinks.note(chatId, `The user restored the project to before an earlier turn. These files were reverted: ${list(files)}.`);
    return this.refresh(chatId);
  }

  private refresh(chatId: string): TimelineEntry[] {
    const entries = this.timeline(chatId);
    this.sinks.timeline(chatId, entries);
    return entries;
  }

  // ── Review Inbox (§9.5) ─────────────────────────────────────────────────

  private review(reviewId: string) {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error("That review item no longer exists.");
    return { review, cp: this.finished(review.turnId) };
  }

  async reviewDiff(reviewId: string): Promise<FileDiff[]> {
    const { cp } = this.review(reviewId);
    return diff(cp.repo, cp.before, cp.after);
  }

  private decide(review: ReviewItem, path: string | undefined, hunk: number | undefined, d: "accepted" | "reverted"): ReviewItem {
    const decisions: ReviewDecisions = structuredClone(review.decisions);
    for (const f of path === undefined ? review.files.map((x) => x.path) : [path]) {
      const entry = (decisions[f] ??= {});
      if (hunk === undefined) entry.file = d;
      else (entry.hunks ??= {})[String(hunk)] = d;
    }
    // Every file decided (as a whole) marks the item reviewed.
    const done = review.files.every((f) => decisions[f.path]?.file);
    const updated = this.store.updateReview(review.id, { decisions, ...(done && !review.reviewedAt && { reviewedAt: Date.now() }) });
    this.sinks.reviews(this.store.listReviews());
    return updated;
  }

  async revert(reviewId: string, path: string, hunk?: number): Promise<ReviewItem> {
    const { review, cp } = this.review(reviewId);
    if (hunk === undefined) {
      await restorePaths(cp.repo, cp.before, [path]);
      this.sinks.note(review.chatId, `The user reverted your changes to \`${path}\`.`);
    } else {
      const file = (await diff(cp.repo, cp.before, cp.after, [path]))[0];
      const h = file?.hunks[hunk];
      if (!file || !h) throw new Error("That change is no longer in the diff.");
      try {
        await revertHunk(cp.repo, path, h, file.change === "created" && file.hunks.length === 1);
      } catch {
        throw new Error(
          `Couldn't revert that part of ${path}: the file has changed since. Revert the whole file instead, or edit it by hand.`,
        );
      }
      this.sinks.note(
        review.chatId,
        `The user reverted one of your changes in \`${path}\` (lines ${h.newStart}–${h.newStart + Math.max(h.newLines, 1) - 1}).`,
      );
    }
    return this.decide(review, path, hunk, "reverted");
  }

  accept(reviewId: string, path?: string, hunk?: number): ReviewItem {
    const review = this.store.getReview(reviewId);
    if (!review) throw new Error("That review item no longer exists.");
    return this.decide(review, path, hunk, "accepted");
  }

  markReviewed(reviewId: string, reviewed: boolean): ReviewItem {
    const updated = this.store.updateReview(reviewId, { reviewedAt: reviewed ? Date.now() : null });
    this.sinks.reviews(this.store.listReviews());
    return updated;
  }

  async askChanges(reviewId: string, path: string, hunk: number | undefined, feedback: string): Promise<void> {
    const { review, cp } = this.review(reviewId);
    let quote = "";
    if (hunk !== undefined) {
      const h = (await diff(cp.repo, cp.before, cp.after, [path]))[0]?.hunks[hunk];
      if (h) quote = `\n\n\`\`\`diff\n@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n\`\`\``;
    }
    await this.sinks.message(review.chatId, `About your change to \`${path}\`:${quote}\n\n${feedback}`);
  }

  // ── Worktrees (§9.3) ────────────────────────────────────────────────────

  async projectGit(folder: string): Promise<{ isRepo: boolean; gitMissing: boolean }> {
    if (!(await gitVersion())) return { isRepo: false, gitMissing: true };
    return { isRepo: (await repoRoot(folder)) !== null, gitMissing: false };
  }

  async initGit(folder: string): Promise<void> {
    if (await repoRoot(folder)) return;
    await initRepo(folder);
  }

  /** A worktree on a new `latis/<slug>` branch from the project's current HEAD (§9.3 AC1). */
  async createWorktree(projectId: string, folder: string, title: string): Promise<{ worktreeId: string; cwd: string }> {
    const repo = await repoRoot(folder);
    if (!repo) throw new Error("This folder isn't a git repository, so it can't have separate copies. Initialise git first.");
    const head = await headCommit(repo);
    if (!head) throw new Error("The repository has no commits yet. Make a first commit, then try again.");
    const baseRef = (await currentBranch(repo)) ?? head;
    const slug = `${slugify(title)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = join(this.dataDir, "worktrees", slugify(basename(repo)));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, slug);
    const branch = `latis/${slug}`;
    await addWorktree(repo, path, branch, "HEAD");
    const wt = this.store.createWorktree({ projectId, path, branch, baseRef, baseCommit: head });
    // A project opened at a subfolder of the repo works in the same subfolder of the copy.
    // realpath: git reports resolved paths (macOS /var → /private/var), the project may not be.
    return { worktreeId: wt.id, cwd: join(path, relative(repo, realpathSync(folder))) };
  }

  private worktree(chatId: string) {
    const chat = this.chat(chatId);
    const wt = chat.worktree && this.store.getWorktree(chat.worktree.id);
    if (!wt || wt.removedAt) throw new Error("This chat isn't working in its own copy.");
    const project = chat.projectId ? this.store.getProject(chat.projectId) : undefined;
    if (!project) throw new Error("This chat's project no longer exists.");
    return { chat, wt, project };
  }

  private async mainRepo(folder: string): Promise<string> {
    const repo = await repoRoot(folder);
    if (!repo) throw new Error("The project folder is no longer a git repository.");
    return repo;
  }

  /** Worktree branch plus uncommitted work vs. where it forked from its base (§9.3 AC3). */
  async branchDiff(chatId: string): Promise<FileDiff[]> {
    const { wt } = this.worktree(chatId);
    const snap = await snapshot(wt.path, "Latis review snapshot");
    const base = (await git(wt.path, ["merge-base", wt.baseRef, snap])).stdout.trim();
    return diff(wt.path, base, snap);
  }

  /** Everything a chat changed: its branch in a worktree, otherwise from before its first turn to after its last. */
  async chatDiff(chatId: string): Promise<FileDiff[]> {
    const chat = this.chat(chatId);
    if (chat.worktree && !chat.worktree.removed) return this.branchDiff(chatId);
    const cps = this.store.chatCheckpoints(chatId).filter((c) => c.after && !c.undoneAt);
    const first = cps[0];
    const last = cps.at(-1);
    if (!first || !last?.after) return [];
    return diff(first.repo, first.before, last.after);
  }

  async mergePreview(chatId: string): Promise<MergePreview> {
    const { chat, wt, project } = this.worktree(chatId);
    // The agent's uncommitted work goes into a commit on its branch so the merge includes it.
    await commitAll(wt.path, `Latis: ${chat.title}`);
    const repo = await this.mainRepo(project.folderPath);
    const ahead = await aheadCount(repo, wt.baseRef, wt.branch);
    const conflicts = ahead ? await mergeConflicts(repo, wt.baseRef, wt.branch) : [];
    const onBranch = await currentBranch(repo);
    const blocker =
      onBranch !== wt.baseRef
        ? `The project folder is on ${onBranch ? `\`${onBranch}\`` : "a detached HEAD"}, not \`${wt.baseRef}\`. Switch it back to merge here.`
        : !(await isClean(repo))
          ? "The project folder has uncommitted changes. Commit or stash them first, so the merge can't mix with them."
          : null;
    return { branch: wt.branch, baseRef: wt.baseRef, ahead, conflicts, blocker };
  }

  async merge(chatId: string, mode: "merge" | "squash"): Promise<{ merged: boolean; conflicts: string[] }> {
    const preview = await this.mergePreview(chatId);
    if (preview.blocker) throw new Error(preview.blocker);
    if (preview.conflicts.length) return { merged: false, conflicts: preview.conflicts };
    const { chat, wt, project } = this.worktree(chatId);
    if (preview.ahead) await merge(await this.mainRepo(project.folderPath), wt.branch, mode, `${chat.title} (${wt.branch})`);
    this.store.updateWorktree(wt.id, { mergedAt: Date.now() });
    return { merged: true, conflicts: [] };
  }

  /** Never drops unmerged commits unless `force` (§9.3 AC5). The chat moves back to the project folder. */
  async removeWorktree(chatId: string, force: boolean): Promise<{ removed: boolean; unmerged: number }> {
    const { chat, wt, project } = this.worktree(chatId);
    const repo = await this.mainRepo(project.folderPath);
    // A squash merge leaves the branch "unmerged" to git, but its work is in the base.
    const deleteUnmerged = force || wt.mergedAt !== null;
    if (!deleteUnmerged) await commitAll(wt.path, `Latis: ${chat.title}`);
    try {
      await removeWorktree(repo, wt.path, wt.branch, { base: wt.baseRef, deleteUnmerged });
    } catch (err) {
      if (err instanceof UnmergedError) return { removed: false, unmerged: err.commits };
      throw err;
    }
    this.store.updateWorktree(wt.id, { removedAt: Date.now() });
    this.store.setChatCwd(chatId, project.folderPath, null);
    return { removed: true, unmerged: 0 };
  }

  async askResolve(chatId: string, files: string[]): Promise<void> {
    const { wt } = this.worktree(chatId);
    await this.sinks.message(
      chatId,
      `Your branch \`${wt.branch}\` conflicts with \`${wt.baseRef}\` in ${list(files)}. Merge \`${wt.baseRef}\` into your branch here, resolve the conflicts, run any checks, and commit.`,
    );
  }
}
