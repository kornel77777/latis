import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { claudeFixtures, launch, stubFolderPicker, tempDataDir } from "./helpers";

type Api = { latis: LatisApi };
const shots = process.env.LATIS_SCREENSHOTS;

test("Settings → Permissions: default mode and the always-ask list, enforced in a Full-auto Claude Code chat", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  const { app, page } = await launch(dataDir, { LATIS_CLAUDE_REPLAY: claudeFixtures });
  const prefs = () => page.evaluate(() => (globalThis as unknown as Api).latis.invoke("prefs:get"));

  // 1. New chats start in Full-auto; the list starts with the defaults and can be edited.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: /Settings…/ }).click();
  await page.getByRole("button", { name: "Permissions" }).click();
  const settings = page.getByTestId("permissions-settings");
  await expect(settings.getByRole("radio", { name: /Auto-edit/ })).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("radio", { name: /Full-auto/ }).click();
  const list = settings.getByTestId("always-ask-list");
  await expect(list).toContainText("git push");
  await expect(list).toContainText("rm -rf");
  await settings.getByLabel("Add a command pattern").fill("terraform   apply");
  await settings.getByRole("button", { name: "Add" }).click();
  await expect(list).toContainText("terraform apply");
  await settings.getByRole("button", { name: "Remove sudo" }).click();
  await expect(list).not.toContainText("sudo");
  await settings.getByLabel("Try a command").fill("cd infra && terraform apply -auto-approve");
  await expect(settings.getByTestId("always-ask-trial")).toHaveText("Asks (matches terraform apply)");
  await settings.getByLabel("Try a command").fill("sudo ls");
  await expect(settings.getByTestId("always-ask-trial")).toHaveText("Runs per the chat's mode");
  await expect(settings).toContainText("Every command is checked");
  if (shots) await page.screenshot({ path: `${shots}/permissions-settings.png` });
  await expect.poll(async () => (await prefs()).defaultPermissionMode).toBe("full-auto");
  expect((await prefs()).alwaysAsk).toEqual(["git push", "rm -rf", "npm publish", "pnpm publish", "git reset --hard", "terraform apply"]);
  await page.keyboard.press("Escape");

  // 2. A Claude Code chat starts in Full-auto, runs the unlisted command without asking and stops at `rm -rf`.
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await page.getByTestId("project-frame").getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: /Claude Code/ }).click();
  const card = page.getByTestId("chat-card");
  await expect(card.getByTestId("permission-picker")).toContainText("Full-auto");
  // Claude Code checks every command, so there's no "can't enforce" warning.
  await expect(card.locator("[title^='Full-auto:']")).toHaveCount(0);
  await card.getByTestId("composer").fill("build then clean /always-ask-bypass");
  await card.getByTestId("send").click();
  const perm = card.getByTestId("permission");
  await expect(perm).toBeVisible({ timeout: 15_000 });
  await expect(perm).toHaveCount(1);
  await expect(perm).toContainText("rm -rf build");
  await expect(perm.getByTestId("always-ask-match")).toContainText("rm -rf");
  await expect(perm.getByTestId("allow-chat")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-status", "needs-you");
  if (shots) await page.screenshot({ path: `${shots}/permissions-always-ask.png` });
  await perm.getByTestId("deny").click();
  await expect(card).toHaveAttribute("data-completed-turns", "1", { timeout: 15_000 });
  await expect(card).toContainText("denied");

  await app.close();
});
