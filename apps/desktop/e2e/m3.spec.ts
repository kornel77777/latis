import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { fixturesRoot, launch, stubFolderPicker, tempDataDir } from "./helpers";

// M3: worktrees, checkpoints/undo/timeline, Review Inbox, merge with conflict detection.
// The demo agent's `/write <word>` script writes src/<word>.txt for real, so git sees real changes.

const shots = process.env.LATIS_SCREENSHOTS;
type Api = { latis: LatisApi };
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function setup() {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "shop");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# shop\n");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "init", "--allow-empty");
  run(repo, "add", "-A");
  run(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "readme");
  const { app, page } = await launch(dataDir, { LATIS_REPLAY: fixturesRoot });
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await expect(page.getByTestId("project-frame")).toContainText("shop");
  return { app, page, repo };
}

/** Demo-agent chats inside the project (the UI keeps the demo agent out of real folders). */
async function demoChats(page: Page, isolate: boolean[]): Promise<void> {
  await page.evaluate(async (flags) => {
    const api = (globalThis as unknown as Api).latis;
    const canvas = await api.invoke("canvas:load");
    for (const isolate of flags) {
      await api.invoke("chat:create", { canvasId: canvas.id, projectId: canvas.projects[0]!.id, agentId: "fake", x: 0, y: 0, isolate });
    }
  }, isolate);
  await page.reload();
  await page.waitForSelector("[aria-label='Canvas']");
}

async function send(card: Locator, text: string, turns: number) {
  await card.getByTestId("composer").fill(text);
  // Enter rather than the Send button, which the minimap can cover in a small window.
  await card.getByTestId("composer").press("Enter");
  await expect(card).toHaveAttribute("data-completed-turns", String(turns), { timeout: 15_000 });
}

test("S1: two agents in their own worktrees, reviewed in the Review Inbox, both merged", async () => {
  const { app, page, repo } = await setup();
  await demoChats(page, [true, true]);
  const cards = page.getByTestId("chat-card");
  await expect(cards).toHaveCount(2);
  const [a, b] = [cards.nth(0), cards.nth(1)];
  await expect(a.getByTestId("branch-chip")).toContainText("demo-agent");

  await send(a, "build /write pricing", 1);
  await send(b, "build /write checkout", 1);
  // Each wrote only in its own copy.
  expect(existsSync(join(repo, "src/pricing.txt"))).toBe(false);

  await expect(page.getByTestId("review-count")).toHaveText("2");
  await page.keyboard.press("Control+Shift+R");
  const panel = page.getByTestId("review-panel");
  await expect(panel.getByTestId("review-item")).toHaveCount(2);
  // Summary = the agent's final message (§9.5 AC1).
  await expect(panel.getByTestId("review-item").first()).toContainText("Wrote src/");
  await panel.getByTestId("review-item").first().click();
  await expect(panel.getByTestId("file-diff")).toHaveCount(1);
  await panel.getByTestId("split-toggle").click();
  if (shots) await page.screenshot({ path: `${shots}/m3-review.png` });
  await panel.getByTestId("accept-all").click();
  await expect(page.getByTestId("review-count")).toHaveText("1");
  await panel.getByTestId("review-item").first().click();
  await panel.getByTestId("accept-all").click();
  await expect(page.getByTestId("review-count")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Merge both: a merge commit, then a squash; then remove the copies.
  for (const [card, mode] of [
    [a, "merge"],
    [b, "squash"],
  ] as const) {
    await card.getByTestId("branch-chip").click();
    await page.getByRole("menuitem", { name: /Merge into main/ }).click();
    const dialog = page.getByTestId("merge-dialog");
    await expect(dialog).toContainText("No conflicts");
    if (mode === "squash") await dialog.getByText("Squash into one commit").click();
    if (shots && mode === "merge") await page.screenshot({ path: `${shots}/m3-merge.png` });
    await dialog.getByTestId("merge-confirm").click();
    await dialog.getByTestId("remove-worktree").click();
    await expect(dialog).toHaveCount(0);
    await expect(card.getByTestId("branch-chip")).toHaveCount(0);
  }
  expect(readFileSync(join(repo, "src/pricing.txt"), "utf8")).toContain("Feature: pricing");
  expect(readFileSync(join(repo, "src/checkout.txt"), "utf8")).toContain("Feature: checkout");
  expect(run(repo, "worktree", "list")).not.toContain("latis/");
  await app.close();
});

test("undo, redo and the timeline; a second chat is offered its own copy", async () => {
  const { app, page, repo } = await setup();
  await demoChats(page, [false]);
  const card = page.getByTestId("chat-card").first();
  await send(card, "/write one", 1);
  await send(card, "/write two", 2);
  expect(existsSync(join(repo, "src/two.txt"))).toBe(true);

  // Each turn's checkpoint lands just after the turn ends.
  await expect(card.getByTestId("undo-turn")).toHaveCount(2);
  await card.getByTestId("undo-turn").last().click();
  await expect.poll(() => existsSync(join(repo, "src/two.txt"))).toBe(false);
  await card.getByTestId("redo-turn").last().click();
  await expect.poll(() => existsSync(join(repo, "src/two.txt"))).toBe(true);

  await card.getByRole("button", { name: "Chat menu" }).click();
  await page.getByRole("menuitem", { name: "Timeline" }).click();
  const entries = page.getByTestId("timeline-entry");
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText("src/one.txt");
  await entries.first().getByTestId("restore-to").click();
  await expect.poll(() => existsSync(join(repo, "src/one.txt"))).toBe(false);
  expect(existsSync(join(repo, "src/two.txt"))).toBe(false);
  await page.keyboard.press("Escape");

  // An existing chat can move into its own copy from its folder chip.
  await card.getByTestId("folder-chip").click();
  await page.getByRole("menuitem", { name: "Work in its own copy" }).click();
  await expect(card.getByTestId("branch-chip")).toBeVisible();
  await send(card, "/write moved", 3);
  expect(existsSync(join(repo, "src/moved.txt"))).toBe(false);

  // §9.3 AC1: another chat in this repo gets the offer of its own copy, on by default.
  await page.getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: /^Codex/ }).click();
  await expect(page.getByTestId("isolate-option").locator("input")).toBeChecked();
  await page.getByTestId("isolate-start").click();
  const codex = page.locator("[data-testid='chat-card'][data-agent='codex']");
  await expect(codex.getByTestId("branch-chip")).toBeVisible();
  await app.close();
});

test("a conflicting merge is caught by the dry run; reverting a change from review", async () => {
  const { app, page, repo } = await setup();
  await demoChats(page, [true, false]);
  const [isolated, main] = [page.getByTestId("chat-card").nth(0), page.getByTestId("chat-card").nth(1)];
  await send(isolated, "/write same", 1);
  // The main folder commits its own src/same.txt meanwhile.
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/same.txt"), "the main folder's version\n");
  run(repo, "add", "-A");
  run(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "main edit");

  await isolated.getByTestId("branch-chip").click();
  await page.getByRole("menuitem", { name: /Merge into main/ }).click();
  const dialog = page.getByTestId("merge-dialog");
  await expect(dialog.getByTestId("merge-conflicts")).toContainText("src/same.txt");
  await dialog.getByTestId("ask-resolve").click();
  await expect(dialog).toHaveCount(0);
  await expect(isolated.getByTestId("user-message").last()).toContainText("conflicts with `main` in `src/same.txt`");
  expect(readFileSync(join(repo, "src/same.txt"), "utf8")).toBe("the main folder's version\n");

  // Revert the main chat's change from the Review Inbox: the file goes back, the agent is told next turn.
  await send(main, "/write extra", 1);
  await page.getByTestId("open-review").click();
  const panel = page.getByTestId("review-panel");
  await panel.getByTestId("review-item").filter({ hasText: "extra" }).click();
  await panel.getByTestId("revert-file").click();
  await expect(panel.getByTestId("decision")).toHaveText("Reverted");
  expect(existsSync(join(repo, "src/extra.txt"))).toBe(false);
  await app.close();
});
