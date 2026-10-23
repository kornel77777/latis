/// <reference lib="dom" />

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

// Design review (M4 exit, §8): screenshots of each surface's states in both themes.
//   LATIS_SCREENSHOTS=<dir> pnpm e2e -- e2e/design.spec.ts
const shots = process.env.LATIS_SCREENSHOTS;
test.skip(!shots, "set LATIS_SCREENSHOTS=<dir> to capture the design review");
test.setTimeout(180_000);
type Api = { latis: LatisApi };

async function snap(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/design-${name}.png` });
}

for (const theme of ["dark", "light"] as const) {
  test(`design review: ${theme}`, async () => {
    const dataDir = tempDataDir();
    const { app, page } = await launch(dataDir, { LATIS_SKIP_ONBOARDING: "1" });
    await page.evaluate((t) => (globalThis as unknown as Api).latis.invoke("settings:setTheme", t), theme);
    await page.reload();
    await page.waitForSelector("[aria-label='Canvas']");
    await snap(page, `${theme}-01-empty`);

    const repo = join(dataDir, "shop");
    mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "# shop\n");
    await stubFolderPicker(app, repo);
    await page.getByTestId("empty-open-folder").click();
    // Three demo chats in different states: needs you, done, error.
    await page.evaluate(async () => {
      const api = (globalThis as unknown as Api).latis;
      const canvas = await api.invoke("canvas:load");
      for (let i = 0; i < 3; i++)
        await api.invoke("chat:create", { canvasId: canvas.id, projectId: null, agentId: "fake", x: 1100 + i * 500, y: 0 });
    });
    await page.reload();
    await page.waitForSelector("[aria-label='Canvas']");
    // From the canvas data: off-screen cards aren't rendered, so the DOM doesn't list them all.
    const ids = await page.evaluate(async () => (await (globalThis as unknown as Api).latis.invoke("canvas:load")).chats.map((c) => c.id));
    await page.evaluate((list) => {
      const api = (globalThis as unknown as Api).latis;
      void api.invoke("chat:send", { chatId: list[0]!, text: "Swap the hero image" });
      void api.invoke("chat:send", { chatId: list[1]!, text: "Summarise the README /ask" });
      void api.invoke("chat:send", { chatId: list[2]!, text: "Break please /crash" });
    }, ids);
    await page.waitForTimeout(4000);
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Shift+1");
    await snap(page, `${theme}-02-tiles`);
    await page.keyboard.press("0");
    await page.evaluate(
      (id) => (globalThis as unknown as { document: Document }).document.querySelector(`[data-chat-id="${id}"]`)?.scrollIntoView(),
      ids[0],
    );
    await page
      .getByTestId("chat-card")
      .first()
      .click({ position: { x: 100, y: 15 } });
    await snap(page, `${theme}-03-chat-needs-you`);

    await page.getByRole("tab", { name: /Inbox/ }).click();
    await snap(page, `${theme}-04-inbox`);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.type("new");
    await snap(page, `${theme}-05-palette`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Backquote");
    await page.getByRole("tab", { name: "Browser" }).click();
    await page.getByTestId("browser-url").fill("localhost:3999");
    await page.getByTestId("browser-url").press("Enter");
    await snap(page, `${theme}-06-browser-error`);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("menuitem", { name: /Settings…/ }).click();
    await page.getByRole("button", { name: "Appearance" }).click();
    await snap(page, `${theme}-07-settings-appearance`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+r");
    await snap(page, `${theme}-08-review-empty`);
    await page.keyboard.press("Escape");
    await app.close();
  });
}
