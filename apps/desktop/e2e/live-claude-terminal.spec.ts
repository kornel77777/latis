import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

// Live (LATIS_LIVE=1, spends a few tokens): the real Claude Code in a terminal tile, on the user's own sign-in.
// Its HTTP hooks reach Latis, and `git push` waits for the always-ask banner.

test.skip(process.env.LATIS_LIVE !== "1", "live: set LATIS_LIVE=1");
type Api = { latis: LatisApi };
const ptySnapshot = (page: Page, id: string | null) =>
  page.evaluate((ptyId) => (globalThis as unknown as Api).latis.invoke("pty:snapshot", { id: ptyId! }).then((r) => r.data), id);
const ptyWrite = (page: Page, id: string | null, data: string) =>
  page.evaluate(([ptyId, d]) => (globalThis as unknown as Api).latis.invoke("pty:write", { id: ptyId!, data: d! }), [id, data] as const);
// eslint-disable-next-line no-control-regex -- terminal escape codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

test("live: Claude Code in a terminal asks Latis before `git push`", async () => {
  test.setTimeout(180_000);
  const dataDir = tempDataDir();
  const repo = join(dataDir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const { app, page } = await launch(dataDir);
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await page.getByTestId("frame-new-chat").click();
  await page.getByRole("menuitem", { name: /^Claude Code/ }).click();
  const card = page.getByTestId("chat-card");
  const ptyId = await card.getByTestId("terminal").getAttribute("data-pty");
  const out = async () => plain(await ptySnapshot(page, ptyId));
  // A new folder: Claude Code asks whether to trust it (the default answer is No).
  // Cursor moves stand in for spaces in its screen, hence the squashed match.
  await expect.poll(out, { timeout: 30_000 }).toMatch(/trust\s*this\s*folder|❯/i);
  if (/trust\s*this\s*folder/i.test(await out())) {
    await ptyWrite(page, ptyId, "\x1b[B");
    await page.waitForTimeout(400);
    await ptyWrite(page, ptyId, "\r");
  }
  await page.waitForTimeout(3000);
  await ptyWrite(page, ptyId, "Use the Bash tool to run exactly `git push origin main`, once. Then reply DONE.");
  await page.waitForTimeout(500);
  await ptyWrite(page, ptyId, "\r");
  await expect(card)
    .toHaveAttribute("data-status", "working", { timeout: 30_000 })
    .catch(async (err: unknown) => {
      console.log("--- terminal ---\n" + (await out()).slice(-3000));
      throw err;
    });
  const banner = card.getByTestId("terminal-requests");
  await expect(banner).toBeVisible({ timeout: 90_000 });
  await expect(banner.getByTestId("always-ask-match")).toContainText("git push");
  await banner.getByTestId("deny").click();
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 90_000 });
  await app.close();
});
