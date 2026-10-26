import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

// Claude Code in its own terminal, on the user's sign-in, wired to Latis through HTTP hooks
// (docs/adapters/claude-code.md → Terminal). A fake `claude` on the agent PATH speaks the same hook protocol.

const shots = process.env.LATIS_SCREENSHOTS;
const env = { LATIS_AGENT_PATH: fileURLToPath(new URL("../../../fixtures/terminal/fake-claude", import.meta.url)) };
type Api = { latis: LatisApi };

const ptySnapshot = (page: Page, id: string | null) =>
  page.evaluate((ptyId) => (globalThis as unknown as Api).latis.invoke("pty:snapshot", { id: ptyId! }).then((r) => r.data), id);
const ptyWrite = (page: Page, id: string | null, data: string) =>
  page.evaluate(([ptyId, d]) => (globalThis as unknown as Api).latis.invoke("pty:write", { id: ptyId!, data: d! }), [id, data] as const);

test("Claude Code in a terminal: hooks drive status, the always-ask banner and the Inbox, and the conversation resumes", async () => {
  const dataDir = tempDataDir();
  const repo = join(dataDir, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# repo\n");
  let { app, page } = await launch(dataDir, env);
  await stubFolderPicker(app, repo);
  await page.getByTestId("empty-open-folder").click();
  await page.getByTestId("frame-new-chat").click();
  const item = page.getByRole("menuitem", { name: /^Claude Code/ });
  await expect(item).toContainText("Your Claude subscription, in its own terminal");
  await item.click();
  let card = page.getByTestId("chat-card");
  await expect(card).toHaveAttribute("data-agent", "terminal:claude");
  let ptyId = await card.getByTestId("terminal").getAttribute("data-pty");
  const out = () => ptySnapshot(page, ptyId);
  await expect.poll(out, { timeout: 10_000 }).toMatch(/Started fake Claude Code \(session [0-9a-f-]{36}\)/);
  const sessionId = /session ([0-9a-f-]{36})/.exec(await out())![1]!;

  // An unlisted command runs without asking.
  await ptyWrite(page, ptyId, "run ls\r");
  await expect.poll(out, { timeout: 10_000 }).toContain("Ran: ls");
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  // A listed one waits for Latis: a banner over the terminal, the chat needs you, the Inbox has it.
  await ptyWrite(page, ptyId, "run git push origin main\r");
  const banner = card.getByTestId("terminal-requests");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner.getByTestId("always-ask-match")).toContainText("git push");
  await expect(banner.getByTestId("allow-chat")).toHaveCount(0);
  await expect(card).toHaveAttribute("data-status", "needs-you");
  await page.getByRole("tab", { name: /Inbox/ }).click();
  await expect(page.getByTestId("inbox-item").first()).toContainText("git push origin main");
  if (shots) await page.screenshot({ path: `${shots}/claude-terminal-always-ask.png` });
  await banner.getByTestId("allow-once").click();
  await expect.poll(out, { timeout: 10_000 }).toContain("Ran: git push origin main");
  await expect(banner).toHaveCount(0);
  await expect(card).toHaveAttribute("data-status", "done", { timeout: 10_000 });

  // Denied in Latis: the agent is told why.
  await ptyWrite(page, ptyId, "run rm -rf build\r");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await banner.getByTestId("deny").click();
  await expect.poll(out, { timeout: 10_000 }).toContain("Blocked: The user denied this in Latis.");

  // Turns typed in the terminal are recorded, so the chat has a timeline.
  await card.getByRole("button", { name: "Chat menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Timeline" })).toBeVisible();
  await page.keyboard.press("Escape");

  // After a restart the same conversation is resumed.
  await app.close();
  ({ app, page } = await launch(dataDir, env));
  card = page.getByTestId("chat-card");
  ptyId = await card.getByTestId("terminal").getAttribute("data-pty");
  await expect.poll(() => ptySnapshot(page, ptyId), { timeout: 10_000 }).toContain(`Resumed fake Claude Code (session ${sessionId})`);
  await app.close();
});
