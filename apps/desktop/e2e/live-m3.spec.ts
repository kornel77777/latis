import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

// M3 exit criterion against real agents: scenario S1 (SPEC §3). Opt-in, spends a few cents:
//   LATIS_LIVE=1 [LATIS_AGENT_PATH=<dir with codex>] pnpm e2e -- e2e/live-m3.spec.ts
test.skip(!process.env.LATIS_LIVE, "set LATIS_LIVE=1 to run against real agents");
test.setTimeout(420_000);

type Api = { latis: LatisApi };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function setModel(page: Page, card: Locator, model: string, reasoning?: string) {
  const chatId = (await card.getAttribute("data-chat-id"))!;
  await page.evaluate((o) => (globalThis as unknown as Api).latis.invoke("chat:setOptions", o), {
    chatId,
    model,
    ...(reasoning && { reasoning }),
  });
}

async function send(card: Locator, text: string) {
  await card.getByTestId("composer").fill(text);
  await card.getByTestId("composer").press("Enter");
}

test("live S1: Claude Code and Codex in separate worktrees, notified, reviewed, both merged", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "store");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# store\n\nA tiny shop for Latis live tests.\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

  const { app, page } = await launch(dataDir);
  const ready = (await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("agents:list", {})))
    .filter((a) => a.installed && a.signedIn)
    .map((a) => a.id);
  test.skip(!ready.includes("claude-code") || !ready.includes("codex"), "needs Claude Code and Codex signed in");
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();

  // Claude Code first, moved into its own copy; Codex second, which is offered one.
  await page.getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: /^Claude Code/ }).click();
  const claude = page.locator("[data-testid='chat-card'][data-agent='claude-code']");
  await claude.getByTestId("folder-chip").click();
  await page.getByRole("menuitem", { name: "Work in its own copy" }).click();
  await expect(claude.getByTestId("branch-chip")).toBeVisible();
  await setModel(page, claude, "haiku");

  await page.getByTestId("new-chat").click();
  await page.getByRole("menuitem", { name: /^Codex/ }).click();
  await page.getByTestId("isolate-start").click();
  const codex = page.locator("[data-testid='chat-card'][data-agent='codex']");
  await expect(codex.getByTestId("branch-chip")).toBeVisible();
  await setModel(page, codex, "gpt-6-luna", "low");

  await send(claude, "Create a file pricing.md containing exactly one line: `# Pricing`. Do nothing else.");
  await send(codex, "Use apply_patch to create a file checkout.md containing exactly one line: `# Checkout`. Do not run shell commands.");
  for (const card of [claude, codex]) {
    // Approve anything they ask for along the way (Auto-edit should cover these edits).
    await expect(async () => {
      const allow = card.getByTestId("allow-once");
      if (await allow.count()) await allow.last().click();
      await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 2000 });
    }).toPass({ timeout: 180_000 });
  }
  // Notified as each finishes: two "finished" Inbox items.
  const inbox = await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("attention:list"));
  expect(inbox.filter((i) => i.kind === "finished")).toHaveLength(2);
  expect(existsSync(join(repo, "pricing.md"))).toBe(false);

  // Review both in the Review Inbox.
  await expect(page.getByTestId("review-count")).toHaveText("2", { timeout: 15_000 });
  await page.getByTestId("open-review").click();
  const panel = page.getByTestId("review-panel");
  for (let i = 0; i < 2; i++) {
    await panel.getByTestId("review-item").first().click();
    await expect(panel.getByTestId("file-diff").first()).toBeVisible();
    await panel.getByTestId("accept-all").click();
  }
  await page.keyboard.press("Escape");

  // Merge both into main.
  for (const card of [claude, codex]) {
    await card.getByTestId("branch-chip").click();
    await page.getByRole("menuitem", { name: /Merge into main/ }).click();
    const dialog = page.getByTestId("merge-dialog");
    await expect(dialog).toContainText("No conflicts", { timeout: 30_000 });
    await dialog.getByTestId("merge-confirm").click();
    await dialog.getByTestId("remove-worktree").click();
    await expect(dialog).toHaveCount(0);
  }
  expect(readFileSync(join(repo, "pricing.md"), "utf8")).toContain("# Pricing");
  expect(readFileSync(join(repo, "checkout.md"), "utf8")).toContain("# Checkout");
  console.log("[S1] main log:\n" + git(repo, "log", "--oneline", "-6"));
  await app.close();
});
