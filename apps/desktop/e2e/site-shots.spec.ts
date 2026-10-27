import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { LattizApi } from "@lattiz/shared";
import { fixturesRoot, launch, stubFolderPicker, tempDataDir } from "./helpers";

// Screenshots for the website (LATTIZ_SITE_SHOTS=<dir>): replayed agents, no tokens spent.

const out = process.env.LATTIZ_SITE_SHOTS;
test.skip(!out, "set LATTIZ_SITE_SHOTS=<dir>");
type Api = { lattiz: LattizApi };

const ptyWrite = (page: Page, id: string | null, data: string) =>
  page.evaluate(([ptyId, d]) => (globalThis as unknown as Api).lattiz.invoke("pty:write", { id: ptyId!, data: d! }), [id, data] as const);

async function say(pane: Locator, text: string) {
  await pane.getByTestId("composer").fill(text);
  await pane.getByTestId("send").click();
}

test("website screenshots", async () => {
  test.setTimeout(120_000);
  const dataDir = tempDataDir();
  const repo = join(dataDir, "acme-web");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# acme-web\n");
  const { app, page } = await launch(dataDir, {
    LATTIZ_LAYOUT: "",
    LATTIZ_REPLAY: fixturesRoot,
    LATTIZ_AGENT_PATH: fileURLToPath(new URL("../../../fixtures/terminal/fake-claude", import.meta.url)),
  });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!;
    w.setSize(1600, 1000);
    w.center();
  });
  await stubFolderPicker(app, repo);
  await page.getByRole("button", { name: "Open folder" }).first().click();
  await page.waitForTimeout(500);

  for (const id of ["claude-code", "codex", "gemini", "terminal:claude"]) {
    await page.getByTestId(`stack-${id}`).last().click();
    await page.waitForTimeout(300);
  }
  const panes = page.getByTestId("lattice-pane");
  await expect(panes).toHaveCount(4);
  const byAgent = (agent: string) => panes.filter({ has: page.locator(`[data-agent="${agent}"]`) });

  await say(byAgent("claude-code"), "Add a health check endpoint and list the files /allow-write-bash");
  await say(byAgent("codex"), "Tidy up the README /edit-file");
  await say(byAgent("gemini"), "Write a hello.txt and check it");
  const term = byAgent("terminal:claude").getByTestId("terminal");
  const ptyId = await term.getAttribute("data-pty");
  await page.waitForTimeout(1500);
  await ptyWrite(page, ptyId, "run npm test\r");

  await expect(byAgent("codex").getByTestId("chat-card")).toHaveAttribute("data-completed-turns", "1", { timeout: 20_000 });
  await expect(byAgent("gemini").getByTestId("chat-card")).toHaveAttribute("data-completed-turns", "1", { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.mouse.move(5, 500);
  await page.screenshot({ path: join(out!, "lattice.png") });

  await page.getByRole("button", { name: "Canvas" }).first().click();
  await page.waitForTimeout(600);
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out!, "canvas.png") });
  await app.close();
});
