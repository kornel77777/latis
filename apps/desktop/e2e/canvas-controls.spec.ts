import { expect, test, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, tempDataDir } from "./helpers";

// Feedback from 0.1.1: deleting chats, moving around the canvas, the Focus name, and two-line menu items.

type Api = { latis: LatisApi };
const shots = process.env.LATIS_SCREENSHOTS;

async function demoChats(page: Page, n: number) {
  await page.evaluate(async (count) => {
    const api = (globalThis as unknown as Api).latis;
    const canvas = await api.invoke("canvas:load");
    for (let i = 0; i < count; i++)
      await api.invoke("chat:create", { canvasId: canvas.id, projectId: null, agentId: "fake", x: i * 520, y: 0 });
  }, n);
  await page.reload();
  await page.waitForSelector("[aria-label='Canvas']");
}

test("chats can be deleted from their menu and the sidebar, and come back with Undo", async () => {
  const { app, page } = await launch(tempDataDir());
  await demoChats(page, 2);
  const cards = page.getByTestId("chat-card");
  await expect(cards).toHaveCount(2);

  await cards.first().getByRole("button", { name: "Chat menu" }).click();
  await page.getByRole("menuitem", { name: "Delete chat" }).click();
  await expect(cards).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(cards).toHaveCount(2);

  const row = page.getByTestId("sidebar-chat").first();
  await row.hover();
  await row.getByTestId("sidebar-chat-delete").click();
  await expect(cards).toHaveCount(1);
  await expect(page.getByTestId("sidebar-chat")).toHaveCount(1);
  await app.close();
});

test("dragging empty canvas pans, arrow keys move the view, Shift + drag selects", async () => {
  const { app, page } = await launch(tempDataDir());
  await demoChats(page, 2);
  const vp = () => page.locator(".react-flow__viewport").getAttribute("style");
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  // Empty canvas below the cards.
  const from = { x: pane.x + pane.width / 2, y: pane.y + pane.height - 80 };

  let at = await vp();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 150, from.y - 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(vp).not.toBe(at);
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);

  at = await vp();
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: pane.height - 20 } });
  await page.keyboard.press("ArrowRight");
  await expect.poll(vp).not.toBe(at);
  at = await vp();
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(vp).not.toBe(at);

  // Shift + drag around both cards selects them.
  await page
    .getByRole("button", { name: /Fit/ })
    .first()
    .click()
    .catch(() => undefined);
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(400);
  const boxes = await page.getByTestId("chat-card").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  const left = Math.min(...boxes.map((b) => b.left)) - 30;
  const top = Math.min(...boxes.map((b) => b.top)) - 30;
  const right = Math.max(...boxes.map((b) => b.right)) + 30;
  const bottom = Math.max(...boxes.map((b) => b.bottom)) + 30;
  await page.keyboard.down("Shift");
  await page.mouse.move(left, top);
  await page.mouse.down();
  await page.mouse.move(right, bottom, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.locator(".react-flow__node.selected")).toHaveCount(2);
  await app.close();
});

test("the Focus button and two-line menu items that don't overlap", async () => {
  const { app, page } = await launch(tempDataDir());
  await demoChats(page, 1);
  await expect(page.getByRole("button", { name: /Focus on the selected chats/ })).toBeVisible();
  await expect(page.getByText("Lock In")).toHaveCount(0);

  await page.getByRole("button", { name: "New chat" }).first().click();
  const items = page.getByRole("menuitem");
  // Agents that aren't installed show their install command as a second line.
  await expect(page.getByRole("menuitem", { name: /Copilot CLI/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("menuitem", { name: /Copilot CLI/ })).toContainText("npm install");
  if (shots) await page.screenshot({ path: `${shots}/new-chat-menu.png` });
  const rects = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
  for (let i = 1; i < rects.length; i++) expect(rects[i]!.top).toBeGreaterThanOrEqual(rects[i - 1]!.bottom - 0.5);
  // Every item's text fits inside it.
  const overflow = await items.evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1).length);
  expect(overflow).toBe(0);
  await page.keyboard.press("Escape");
  await app.close();
});
