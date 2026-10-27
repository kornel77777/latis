import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentEvent, AgentSession, ReviewItem } from "@lattiz/shared";
import { SessionSupervisor } from "../../src/main/agents/supervisor";
import { Changes } from "../../src/main/git/changes";
import { git, initRepo } from "../../src/main/git/git";
import { openDb } from "../../src/main/store/db";
import { EventLog } from "../../src/main/store/event-log";
import { WorkspaceStore } from "../../src/main/store/workspace";

/** An agent that writes `<word>.txt` (the message's last word) into its own folder, then finishes. */
function writerAdapter(received: string[]): AgentAdapter {
  return {
    id: "writer",
    displayName: "Writer",
    hue: "sky",
    capabilities: {} as AgentAdapter["capabilities"],
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ signedIn: true }),
    listModels: async () => [],
    terminalCommand: (o) => ({ file: "sh", args: [], cwd: o.cwd }),
    startSession: async (opts): Promise<AgentSession> => {
      const listeners = new Set<(e: AgentEvent) => void>();
      const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));
      return {
        id: "s",
        async send({ text }) {
          received.push(text);
          const word = text.trim().split(/\s+/).at(-1)!;
          setTimeout(() => {
            writeFileSync(join(opts.cwd, `${word}.txt`), `feature ${word}\nline 2\n`);
            emit({ type: "message.completed", text: `Wrote ${word}.txt.\nSecond line.\nThird line.` });
            emit({ type: "turn.completed", status: "ok", durationMs: 1 });
          }, 5);
        },
        async interrupt() {},
        async respond() {},
        onEvent: (l) => (listeners.add(l), () => listeners.delete(l)),
        onExit: () => () => undefined,
        async dispose() {},
      };
    },
  };
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "lattiz-changes-"));
  const repo = join(dataDir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  await initRepo(repo);
  const store = new WorkspaceStore(openDb(join(dataDir, "lattiz.db")));
  const canvasId = store.ensureDefaultCanvas();
  const { project } = store.createProject({ canvasId, folderPath: repo, x: 0, y: 0 });
  const reviews: ReviewItem[][] = [];
  const received: string[] = [];
  // Late-bound: Changes and the supervisor need each other.
  const ref: { sup?: SessionSupervisor } = {};
  const changes = new Changes(store, dataDir, {
    reviews: (items) => reviews.push(items),
    timeline: () => undefined,
    note: (chatId, text) => ref.sup!.addNote(chatId, text),
    message: async (chatId, text) => void (await ref.sup!.steer(chatId, text)),
  });
  const sup = new SessionSupervisor(
    store,
    new EventLog(store),
    new Map([["writer", writerAdapter(received)]]),
    {
      event: () => undefined,
      status: () => undefined,
      updated: () => undefined,
      queue: () => undefined,
      turn: () => undefined,
      attention: () => undefined,
      raised: () => undefined,
    },
    {
      beforeTurn: (c, t) => changes.beforeTurn(c, t),
      afterTurn: (c, t, m) => changes.afterTurn(c, t, m),
    },
  );
  ref.sup = sup;
  const chat = async (isolate: boolean) => {
    const own = isolate ? await changes.createWorktree(project.id, repo, "Writer") : null;
    return store.createChatNode({
      canvasId,
      projectId: project.id,
      parentId: project.frameNodeId,
      x: 0,
      y: 0,
      agentId: "writer",
      model: null,
      reasoning: null,
      permissionMode: "auto-edit",
      cwd: own?.cwd ?? repo,
      worktreeId: own?.worktreeId ?? null,
      title: isolate ? "Isolated" : "Main",
    }).chat;
  };
  return { store, sup, changes, chat, repo, reviews, received };
}

const settle = () => new Promise((r) => setTimeout(r, 400));

describe("safe changes", () => {
  it("S1: two chats in their own worktrees, review items for each, both merged into the base branch", async () => {
    const { sup, changes, chat, repo, reviews, store } = await setup();
    const a = await chat(true);
    const b = await chat(true);
    expect(a.worktree?.branch).toMatch(/^lattiz\/writer-/);
    expect(a.cwd).not.toBe(repo);
    await sup.send(a.id, "build pricing");
    await sup.send(b.id, "build checkout");
    await settle();
    // Each agent wrote only in its own copy.
    expect(existsSync(join(repo, "pricing.txt"))).toBe(false);
    const open = reviews.at(-1)!.filter((r) => r.reviewedAt === null);
    expect(
      open
        .map((r) => r.files.map((f) => f.path))
        .flat()
        .sort(),
    ).toEqual(["checkout.txt", "pricing.txt"]);
    expect(open[0]!.summary).toBe(open[0]!.summary.split("\n").slice(0, 2).join("\n"));

    const preview = await changes.mergePreview(a.id);
    expect(preview).toMatchObject({ ahead: 1, conflicts: [], blocker: null });
    expect((await changes.branchDiff(b.id)).map((f) => f.path)).toEqual(["checkout.txt"]);
    expect(await changes.merge(a.id, "merge")).toEqual({ merged: true, conflicts: [] });
    expect(await changes.merge(b.id, "squash")).toEqual({ merged: true, conflicts: [] });
    expect(readFileSync(join(repo, "pricing.txt"), "utf8")).toContain("feature pricing");
    expect(readFileSync(join(repo, "checkout.txt"), "utf8")).toContain("feature checkout");

    // Squash-merged work counts as merged, so removal doesn't ask; the chat moves back to the project folder.
    expect(await changes.removeWorktree(b.id, false)).toEqual({ removed: true, unmerged: 0 });
    expect(store.getChat(b.id)).toMatchObject({ cwd: repo, worktree: null });
  });

  it("finds conflicts in a dry run and asks the agent to resolve them", async () => {
    const { sup, changes, chat, repo, received } = await setup();
    const a = await chat(true);
    await sup.send(a.id, "build same");
    await settle();
    writeFileSync(join(repo, "same.txt"), "the main folder's own version\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main edit"]);
    const r = await changes.merge(a.id, "merge");
    expect(r).toEqual({ merged: false, conflicts: ["same.txt"] });
    expect(readFileSync(join(repo, "same.txt"), "utf8")).toBe("the main folder's own version\n");
    await changes.askResolve(a.id, r.conflicts);
    expect(received.at(-1)).toContain("conflicts with");
    // An unmerged branch isn't deleted without confirmation.
    const removal = await changes.removeWorktree(a.id, false);
    expect(removal.removed).toBe(false);
    expect(removal.unmerged).toBeGreaterThan(0);
  });

  it("refuses to merge into a dirty project folder", async () => {
    const { sup, changes, chat, repo } = await setup();
    const a = await chat(true);
    await sup.send(a.id, "build x");
    await settle();
    writeFileSync(join(repo, "README.md"), "# edited but not committed\n");
    expect((await changes.mergePreview(a.id)).blocker).toMatch(/uncommitted changes/);
    await expect(changes.merge(a.id, "merge")).rejects.toThrow(/uncommitted/);
  });

  it("undoes and redoes a turn, restores to before a turn, and tells the agent", async () => {
    const { sup, changes, chat, repo, received, store } = await setup();
    const c = await chat(false);
    await sup.send(c.id, "write one");
    await settle();
    await sup.send(c.id, "write two");
    await settle();
    const [t1, t2] = changes.timeline(c.id);
    expect(t1).toMatchObject({ files: ["one.txt"], restorable: true, undone: false });

    await changes.undo(c.id, t2!.turnId);
    expect(existsSync(join(repo, "two.txt"))).toBe(false);
    await changes.redo(c.id, t2!.turnId);
    expect(existsSync(join(repo, "two.txt"))).toBe(true);

    const after = await changes.restoreTo(c.id, t1!.turnId);
    expect(after.every((e) => e.undone)).toBe(true);
    expect(existsSync(join(repo, "one.txt"))).toBe(false);
    expect(existsSync(join(repo, "two.txt"))).toBe(false);

    await sup.send(c.id, "write three");
    await settle();
    expect(received.at(-1)).toMatch(/^\[Note from Lattiz\] The user undid/m);
    expect(received.at(-1)).toContain("[Note from Lattiz] The user restored");
    // The transcript keeps what the user typed.
    expect(store.turns(c.id).at(-1)?.userText).toBe("write three");
  });

  it("reverts a single hunk from the Review Inbox and accepts the rest", async () => {
    const { sup, changes, chat, repo, store } = await setup();
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`);
    writeFileSync(join(repo, "big.txt"), lines.join("\n") + "\n");
    await git(repo, ["add", "-A"]);
    await git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "big"]);
    const c = await chat(false);
    await sup.send(c.id, "write noop");
    await settle();
    // Edit two far-apart places "as the agent" during a second turn.
    const edited = [...lines];
    edited[2] = "AGENT 3";
    edited[26] = "AGENT 27";
    await changes.beforeTurn(c.id, "manual-turn");
    writeFileSync(join(repo, "big.txt"), edited.join("\n") + "\n");
    await changes.afterTurn(c.id, "manual-turn", "Edited big.txt");
    const review = store.listReviews().find((r) => r.turnId === "manual-turn")!;
    const files = await changes.reviewDiff(review.id);
    expect(files[0]!.hunks).toHaveLength(2);
    const reverted = await changes.revert(review.id, "big.txt", 0);
    expect(readFileSync(join(repo, "big.txt"), "utf8")).toContain("row 3\n");
    expect(readFileSync(join(repo, "big.txt"), "utf8")).toContain("AGENT 27");
    expect(reverted.decisions["big.txt"]?.hunks?.["0"]).toBe("reverted");
    const done = changes.accept(review.id, "big.txt");
    expect(done.reviewedAt).not.toBeNull();
  });
});
