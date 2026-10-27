import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

// M1 exit criterion against the real Claude Code CLI. Opt-in: spends real tokens (Haiku, a few cents).
//   LATTIZ_LIVE=1 pnpm e2e -- e2e/live.spec.ts
test.skip(!process.env.LATTIZ_LIVE, "set LATTIZ_LIVE=1 to run against the real Claude Code");
test.setTimeout(240_000);

test("live: open a repo, chat with Claude Code, approve a command, see the diff, restart and resume", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "live-repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# live repo\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });

  let { app, page } = await launch(dataDir);
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await page.getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: /Claude Code/ }).click();
  const card = page.getByTestId("chat-card");

  await card.getByTestId("model-picker").click();
  await page.getByRole("menuitem", { name: /Haiku/ }).first().click();
  await card.getByTestId("permission-picker").click();
  await page.getByRole("menuitem", { name: /^Ask/ }).click();

  await card
    .getByTestId("composer")
    .fill(
      "Use the Write tool to create hello.txt containing exactly the word hi. Then run the shell command `ls`. Then reply in one short sentence.",
    );
  await card.getByTestId("send").click();

  // Approve whatever Claude Code asks for (it may skip asking for read-only commands like `ls`) until the turn completes.
  const deadline = Date.now() + 150_000;
  while ((await card.getAttribute("data-completed-turns")) !== "1" && Date.now() < deadline) {
    const allow = card.locator('[data-testid="permission"][data-pending="true"] [data-testid="allow-once"]');
    if (await allow.count())
      await allow
        .first()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 120_000 });
  expect(readFileSync(join(repo, "hello.txt"), "utf8").trim()).toBe("hi");
  await expect(card.getByTestId("diff").first()).toContainText("hi");
  if (process.env.LATTIZ_SCREENSHOTS) await page.screenshot({ path: `${process.env.LATTIZ_SCREENSHOTS}/live-1.png` });

  await app.close();
  ({ app, page } = await launch(dataDir));
  const again = page.getByTestId("chat-card");
  await expect(again).toHaveAttribute("data-completed-turns", "1");
  await again
    .getByTestId("composer")
    .fill("Without using any tools: what is the name of the file you created earlier? Answer with just the filename.");
  await again.getByTestId("send").click();
  await expect(again).toHaveAttribute("data-completed-turns", "2", { timeout: 120_000 });
  await expect(again.getByTestId("assistant-message").last()).toContainText("hello.txt");
  if (process.env.LATTIZ_SCREENSHOTS) await page.screenshot({ path: `${process.env.LATTIZ_SCREENSHOTS}/live-2.png` });
  await app.close();
});
