import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { claudeFixtures, launch, stubFolderPicker, tempDataDir } from "./helpers";

const shots = process.env.LATIS_SCREENSHOTS;
const env = { LATIS_CLAUDE_REPLAY: claudeFixtures };

async function sendMessage(page: Page, text: string) {
  const card = page.getByTestId("chat-card");
  await card.getByTestId("composer").fill(text);
  await card.getByTestId("send").click();
}

test("Claude Code in a project: permissions, diffs, questions, plans, restart", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "my-repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# my repo\n");

  let { app, page } = await launch(dataDir, env);
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  const frame = page.getByTestId("project-frame");
  await expect(frame).toContainText("my-repo");
  await expect(page.getByTestId("sidebar-project")).toContainText("my-repo");

  await frame.getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: /^Claude(?! Code)/ }).click();
  const card = page.getByTestId("chat-card");
  await expect(card).toHaveAttribute("data-agent", "claude-code");
  await expect(card).toContainText("my-repo");

  // 1. Permission round-trip for a shell command.
  await sendMessage(page, "make hello.txt and run ls /allow-write-bash");
  const perm = card.getByTestId("permission");
  await expect(perm).toBeVisible({ timeout: 15_000 });
  await expect(perm).toContainText("ls");
  await expect(card).toHaveAttribute("data-status", "needs-you");
  await perm.getByTestId("allow-once").click();
  await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 15_000 });
  await expect(card.getByTestId("assistant-message").last()).toContainText("hello.txt");
  await expect(card).toHaveAttribute("data-status", "done");
  // Auto-titled from the first message.
  await expect(card.getByTestId("chat-title")).toHaveText("make hello.txt and run ls /allow-write-bash");

  // 2. Edits render as inline diffs on their step rows.
  await sendMessage(page, "create a.txt /two-turns-edit");
  await card.getByTestId("permission").last().getByTestId("allow-chat").click();
  await expect(card).toHaveAttribute("data-completed-turns", "2", { timeout: 15_000 });
  await sendMessage(page, "now edit it");
  await card.getByTestId("permission").last().getByTestId("allow-once").click();
  await expect(card).toHaveAttribute("data-completed-turns", "3", { timeout: 15_000 });
  const stat = card.getByTestId("diff-stat").last();
  await expect(stat).toContainText("+1");
  await expect(stat).toContainText("−1");
  await expect(card.getByTestId("diff").last()).toContainText("two");
  if (shots) await page.screenshot({ path: `${shots}/m1-diff.png` });

  // 3. Structured question.
  await sendMessage(page, "greet me /ask-question");
  const q = card.getByTestId("question");
  await expect(q).toBeVisible({ timeout: 15_000 });
  await q.getByRole("button", { name: /Hello/ }).click();
  await q.getByTestId("answer").click();
  await expect(card).toHaveAttribute("data-completed-turns", "4", { timeout: 15_000 });

  // 4. Plan approval.
  await sendMessage(page, "plan it /plan-mode");
  const plan = card.getByTestId("plan");
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan).toContainText("CONTRIBUTING.md");
  if (shots) await page.screenshot({ path: `${shots}/m1-plan.png` });
  await plan.getByTestId("approve-plan").click();
  await expect(card).toHaveAttribute("data-completed-turns", "5", { timeout: 20_000 });

  // 5. Model picker lists the agent's models.
  await card.getByTestId("model-picker").click();
  await expect(page.getByRole("menuitem", { name: "Opus 5.5" })).toBeVisible();
  await page.keyboard.press("Escape");

  // 6. Permission mode persists.
  await card.getByTestId("permission-picker").click();
  await page.getByRole("menuitem", { name: /^Ask/ }).click();
  await expect(card.getByTestId("permission-picker")).toContainText("Ask");

  await app.close();
  ({ app, page } = await launch(dataDir, env));
  const again = page.getByTestId("chat-card");
  await expect(page.getByTestId("project-frame")).toContainText("my-repo");
  await expect(again).toHaveAttribute("data-completed-turns", "5");
  await expect(again.getByTestId("permission-picker")).toContainText("Ask");
  await expect(again.getByTestId("chat-title")).toHaveText("make hello.txt and run ls /allow-write-bash");

  // The conversation continues after restart (resumed by session id).
  await sendMessage(page, "once more /deny-write");
  await again.getByTestId("permission").last().getByTestId("deny").click();
  await expect(again).toHaveAttribute("data-completed-turns", "6", { timeout: 15_000 });
  await expect(again.getByTestId("step").last()).toContainText("denied");
  await app.close();
});

test("starting a chat without Claude Code installed explains how to install it", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "r");
  mkdirSync(repo);
  // Empty PATH-less replay dir: point replay at a folder with no fixtures and hide the CLI.
  const { app, page } = await launch(dataDir, { PATH: "/nonexistent", SHELL: "/bin/false" });
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await page.getByTestId("frame-new-chat").click();
  const item = page.getByRole("menuitem", { name: /Claude Code/ });
  await expect(item).toContainText("npm install -g @anthropic-ai/claude-code");
  await expect(item).toHaveAttribute("data-disabled", "");
  await app.close();
});
