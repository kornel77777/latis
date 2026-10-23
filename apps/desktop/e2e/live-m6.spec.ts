import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, tempDataDir } from "./helpers";

// M6 exit criterion against real agents: scenario S6 (SPEC §3), a scheduled daily flow.
// Opt-in, spends real usage:
//   LATIS_LIVE=1 pnpm e2e -- e2e/live-m6.spec.ts
test.skip(!process.env.LATIS_LIVE, "set LATIS_LIVE=1 to run against real agents");
test.setTimeout(900_000);

type Api = { latis: LatisApi };

test("live S6: a daily 08:00 flow; one agent checks dependency updates, another summarises, the result waits for approval in a note", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "shop");
  mkdirSync(repo);
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "shop", version: "1.0.0", dependencies: { express: "4.17.1", lodash: "4.17.15", zod: "3.22.0" } }, null, 2),
  );
  const { app, page } = await launch(dataDir);
  const agents = await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("agents:list", {}));
  const ready = agents.filter((a) => a.installed && a.signedIn && a.kind === "structured" && a.id !== "fake").map((a) => a.id);
  test.skip(!ready.includes("claude-code") || !ready.includes("codex"), "needs Claude Code and Codex signed in");

  const r = await page.evaluate(
    async (cwd) =>
      (globalThis as unknown as Api).latis.invoke("flow:create", {
        canvasId: "main",
        x: 0,
        y: 0,
        spec: {
          name: "Morning dependency digest",
          brief: "Plain words, under 150 words. Don't change any files.",
          cwd,
          permissionMode: "read-only",
          schedule: { every: "daily", at: "08:00" },
          nodes: [
            { id: "start", type: "start", title: "Each morning", input: "Check this project's dependencies for available updates." },
            {
              id: "deps",
              type: "chat",
              agent: "claude-code",
              title: "Dependency check",
              job: "Read package.json and say, from what you know, which dependencies are behind their latest major or minor version and why it matters. Don't run anything.",
            },
            {
              id: "writer",
              type: "chat",
              agent: "codex",
              title: "Writer",
              job: "Turn the dependency check into a short morning digest with a recommended next step.",
            },
            { id: "out", type: "note", title: "Morning digest" },
          ],
          edges: [
            { from: "start", to: "deps" },
            { from: "deps", to: "writer" },
            { from: "writer", to: "out", mode: "approval" },
          ],
        },
      }),
    repo,
  );
  expect(new Date(r.flow.nextRunAt!).getHours()).toBe(8);
  // Run the morning now instead of waiting for 08:00 (the schedule itself is covered by the native tests).
  await page.evaluate(async (id) => (globalThis as unknown as Api).latis.invoke("flow:start", { flowId: id }), r.flow.id);
  const flowInfo = async () => (await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"))).flows[0]!;
  await expect.poll(async () => (await flowInfo()).run!.approvals.length, { timeout: 800_000, intervals: [3000] }).toBe(1);
  const pending = (await flowInfo()).run!.approvals[0]!;
  console.log("digest awaiting approval:\n" + pending.text);
  await page.evaluate(
    async (a) => (globalThis as unknown as Api).latis.invoke("flow:approve", { flowId: a.flowId, approvalId: a.id, action: "keep" }),
    { flowId: r.flow.id, id: pending.id },
  );
  const done = await flowInfo();
  console.log(
    JSON.stringify(
      done.run!.log.map((l) => l.text),
      null,
      1,
    ),
  );
  expect(done.run!.status).toBe("done");
  const note = (await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"))).nodes.find(
    (n) => n.type === "note",
  )!;
  expect(String(note.data.text)).toContain("### From Writer");
  expect(String(note.data.text).length).toBeGreaterThan(150);
  await app.close();
});

test("live S5 (handoff part): Claude Code starts a task in its own copy, Codex continues it from the brief in the same worktree", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, readFileSync } = await import("node:fs");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const dataDir = tempDataDir();
  const repo = join(dataDir, "shop");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# shop\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const { app, page } = await launch(dataDir);
  const { stubFolderPicker } = await import("./helpers");
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  const claude = await page.evaluate(async () => {
    const l = (globalThis as unknown as Api).latis;
    const c = await l.invoke("canvas:load");
    const { chat } = await l.invoke("chat:create", {
      canvasId: c.id,
      projectId: c.projects[0]!.id,
      agentId: "claude-code",
      x: 0,
      y: 0,
      isolate: true,
      permissionMode: "auto-edit",
      model: "haiku",
    });
    await l.invoke("chat:send", {
      chatId: chat.id,
      text: "Create src/cart.ts exporting total(items: {price: number; qty: number}[]): number. Do only that. Then end your reply with a checklist of what's left: '- [ ] Apply discount codes' and '- [ ] Unit tests for total'.",
    });
    return chat.id;
  });
  const status = async (id: string) =>
    (await page.evaluate(async () => (globalThis as unknown as Api).latis.invoke("canvas:load"))).chats.find((c) => c.id === id)!;
  await expect.poll(async () => (await status(claude)).status, { timeout: 300_000, intervals: [2000] }).toMatch(/done|error/);
  const { brief } = await page.evaluate(async (id) => (globalThis as unknown as Api).latis.invoke("handoff:brief", { chatId: id }), claude);
  console.log(brief);
  expect(brief).toContain("src/cart.ts");
  expect(brief).toContain("- [ ] Apply discount codes");
  const started = await page.evaluate(
    async (o) =>
      (globalThis as unknown as Api).latis.invoke("handoff:start", {
        chatId: o.id,
        agentId: "codex",
        brief: o.brief + "\n\nDo only the discount codes item: add applyDiscount(total, code) where SAVE10 takes 10% off.",
      }),
    { id: claude, brief },
  );
  // Codex asks before commands in Auto-edit, as the user would see; approve them like the user would from the Inbox.
  const deadline = Date.now() + 400_000;
  for (;;) {
    const st = (await status(started.chat.id)).status;
    if (st === "done" || st === "error" || Date.now() > deadline) break;
    if (st === "needs-you")
      await page.evaluate(async (id) => {
        const l = (globalThis as unknown as Api).latis;
        for (const item of await l.invoke("attention:list"))
          if (item.chatId === id && item.refId)
            await l.invoke("chat:respond", { chatId: id, requestId: item.refId, response: { kind: "permission", decision: "allow-once" } });
      }, started.chat.id);
    await page.waitForTimeout(2000);
  }
  const a = await status(claude);
  const b = await status(started.chat.id);
  expect(b.worktree?.id).toBe(a.worktree?.id);
  const cart = join(a.cwd, "src", "cart.ts");
  expect(existsSync(cart)).toBe(true);
  const src =
    readFileSync(cart, "utf8") +
    (existsSync(join(a.cwd, "src", "discount.ts")) ? readFileSync(join(a.cwd, "src", "discount.ts"), "utf8") : "");
  console.log(src);
  expect(src).toMatch(/applyDiscount/);
  expect(git(repo, "status", "--porcelain")).toBe(""); // main is untouched: all work is in the copy
  await app.close();
});
