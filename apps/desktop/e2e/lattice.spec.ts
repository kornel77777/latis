/// <reference lib="dom" />

import { expect, test, type Page } from "@playwright/test";
import type { LattizApi } from "@lattiz/shared";
import { launch, tempDataDir } from "./helpers";

// The lattice (chats tiled side by side) and the command table (Settings → Commands).

type Api = { lattiz: LattizApi };
const mod = process.platform === "darwin" ? "Meta" : "Control";
const shots = process.env.LATTIZ_SCREENSHOTS;

async function demoChats(page: Page, n: number) {
  await page.evaluate(async (count) => {
    const api = (globalThis as unknown as Api).lattiz;
    const canvas = await api.invoke("canvas:load");
    for (let i = 0; i < count; i++) {
      const { chat } = await api.invoke("chat:create", { canvasId: canvas.id, projectId: null, agentId: "fake", x: i * 500, y: 0 });
      await api.invoke("chat:setOptions", { chatId: chat.id, title: `Chat ${i + 1}` });
    }
  }, n);
  await page.reload();
  await page.waitForSelector("[aria-label='Canvas']");
}

const order = (page: Page) => page.getByTestId("lattice-pane").getByTestId("chat-title").allInnerTexts();

test("lattice: chats tile in, rearrange by drag, keyboard and presets, and the layout persists", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  await demoChats(page, 4);
  await page.keyboard.press(`${mod}+1`);
  await expect(page.getByTestId("lattice")).toBeVisible();
  await expect(page.getByTestId("lattice-pane")).toHaveCount(4);
  if (shots) await page.screenshot({ path: `${shots}/lattice-tiled.png` });

  await page.getByTestId("arrange-columns").click();
  await expect.poll(() => order(page)).toEqual(["Chat 1", "Chat 2", "Chat 3", "Chat 4"]);

  // Drag Chat 4 by its header onto the left edge of Chat 1.
  const from = page.getByTestId("lattice-pane").filter({ hasText: "Chat 4" }).getByTestId("pane-grip");
  const to = await page.getByTestId("lattice-pane").filter({ hasText: "Chat 1" }).boundingBox();
  const fb = (await from.boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 8 });
  await expect(page.getByTestId("drop-hint")).toHaveAttribute("data-zone", "left");
  await page.mouse.up();
  await expect.poll(() => order(page)).toEqual(["Chat 4", "Chat 1", "Chat 2", "Chat 3"]);

  // Keyboard: Chat 4 is focused; move it right, then focus left.
  await page
    .locator("[aria-label='Arrange']")
    .click({ position: { x: 1, y: 1 } })
    .catch(() => undefined);
  await page.keyboard.press(`${mod}+Alt+Shift+ArrowRight`);
  await expect.poll(() => order(page)).toEqual(["Chat 1", "Chat 4", "Chat 2", "Chat 3"]);
  await page.keyboard.press(`${mod}+Alt+ArrowLeft`);
  expect(await page.evaluate(() => document.querySelector("[data-pane][data-focused] [data-testid=chat-title]")?.textContent)).toBe(
    "Chat 1",
  );

  // Maximise and restore; take a chat out and put it back.
  await page.keyboard.press(`${mod}+Shift+Enter`);
  await expect(page.getByTestId("lattice-pane")).toHaveCount(1);
  await page.keyboard.press(`${mod}+Shift+Enter`);
  await expect(page.getByTestId("lattice-pane")).toHaveCount(4);
  await page.getByTestId("lattice-pane").filter({ hasText: "Chat 2" }).getByRole("button", { name: "Take out of the lattice" }).click();
  await expect(page.getByTestId("lattice-pane")).toHaveCount(3);
  await page.getByRole("button", { name: "Chats taken out" }).click();
  await page.getByRole("menuitem", { name: "Chat 2" }).click();
  await expect(page.getByTestId("lattice-pane")).toHaveCount(4);

  // Resize with a gutter, then grid; the layout survives a restart.
  await page.getByTestId("arrange-grid").click();
  const gutter = page.getByTestId("lattice-gutter").first();
  const g = (await gutter.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 120, g.y + g.height / 2 + 120, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const saved = await page.evaluate(async () => (globalThis as unknown as Api).lattiz.invoke("lattice:get"));
  expect(saved.root?.kind).toBe("split");
  if (shots) await page.screenshot({ path: `${shots}/lattice-grid.png` });
  await app.close();

  const again = await launch(dataDir);
  await expect(again.page.getByTestId("lattice-pane")).toHaveCount(4);
  expect(await again.page.evaluate(async () => (globalThis as unknown as Api).lattiz.invoke("lattice:get"))).toEqual(saved);
  await again.app.close();
});

test("commands: every shortcut is listed, can be re-bound by pressing keys, warns on conflicts, and resets", async () => {
  const { app, page } = await launch(tempDataDir());
  await page.keyboard.press(`${mod}+/`);
  const table = page.getByTestId("commands");
  await expect(table).toBeVisible();
  await table.getByLabel("Search commands").fill("lattice");
  const row = table.locator("[data-command='view.lattice']");
  await expect(row.getByTestId("shortcut")).toHaveCount(1);

  // Add Alt+L by pressing it.
  await row.getByTestId("add-shortcut").click();
  await page.keyboard.press("Alt+L");
  await expect(row.getByTestId("shortcut")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+L");
  await expect(page.getByTestId("lattice")).toBeVisible();

  // Giving "Show the canvas" the same chord shows a conflict on both.
  await page.keyboard.press(`${mod}+/`);
  await table.getByLabel("Search commands").fill("show the");
  const canvasRow = table.locator("[data-command='view.canvas']");
  await canvasRow.getByTestId("add-shortcut").click();
  await page.keyboard.press("Alt+L");
  await expect(canvasRow.locator(".text-state-needs-you")).toHaveCount(1);
  await expect(table.locator("[data-command='view.lattice'] .text-state-needs-you")).toHaveCount(1);

  // Reset all puts the defaults back.
  await table.getByRole("button", { name: "Reset all" }).click();
  await expect(canvasRow.getByTestId("shortcut")).toHaveCount(1);
  const prefs = await page.evaluate(async () => (globalThis as unknown as Api).lattiz.invoke("prefs:get"));
  expect(prefs.keybindings).toEqual({});
  await app.close();
});

test("canvas: two-finger scroll / the wheel pans by default, and zooms when set to", async () => {
  const { app, page } = await launch(tempDataDir());
  await demoChats(page, 1);
  const badge = page.getByTestId("zoom-badge");
  const box = (await page.locator(".react-flow__pane").boundingBox())!;
  const vp = () => page.locator(".react-flow__viewport").getAttribute("style");
  await page.mouse.move(box.x + 60, box.y + box.height - 60);
  const zoom = await badge.textContent();
  const at = await vp();
  await page.mouse.wheel(0, 300);
  await expect.poll(vp).not.toBe(at);
  await expect(badge).toHaveText(zoom!);

  // Appearance → Scroll wheel → Zoom.
  await page.evaluate(async () => {
    const api = (globalThis as unknown as Api).lattiz;
    const p = await api.invoke("prefs:get");
    await api.invoke("prefs:set", { appearance: { ...p.appearance, wheel: "zoom" } });
  });
  await page.reload();
  await page.waitForSelector("[aria-label='Canvas']");
  await page.mouse.move(box.x + 60, box.y + box.height - 60);
  const before = await badge.textContent();
  await page.mouse.wheel(0, -400);
  await expect(badge).not.toHaveText(before!);
  await app.close();
});

test("lattice: a streaming reply keeps the transcript at the bottom until the user scrolls up", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  await demoChats(page, 2);
  await page.keyboard.press(`${mod}+1`);
  await expect(page.getByTestId("lattice-pane")).toHaveCount(2);

  const pane = page.getByTestId("lattice-pane").filter({ hasText: "Chat 1" });
  const scroller = pane.getByTestId("transcript").getByTestId("virtuoso-scroller");
  const gap = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const height = () => scroller.evaluate((el) => el.scrollHeight);

  const composer = pane.getByTestId("composer");
  await composer.fill("go /long");
  await composer.press("Enter");

  // While it streams, the list grows and the view follows it.
  await expect.poll(height, { timeout: 5_000 }).toBeGreaterThan(1_500);
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(250);
    expect(await gap()).toBeLessThan(40);
  }

  // Scrolling up stops the following; the view stays where the user put it.
  const box = (await scroller.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  const top = await scroller.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(800);
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - top)).toBeLessThan(2);

  // Scrolling back to the bottom follows again.
  await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await page.waitForTimeout(500);
  expect(await gap()).toBeLessThan(40);
  await app.close();
});

test("lattice is the default: stack agents, split a pane, message them all, pass a reply and ask for a review", async () => {
  const dataDir = tempDataDir();
  // The real default layout, not the canvas the other specs start on.
  const { app, page } = await launch(dataDir, { LATTIZ_LAYOUT: "" });
  await expect(page.getByTestId("lattice")).toBeVisible();

  // Empty lattice: one click starts an agent.
  await page.getByTestId("stack-fake").last().click();
  await expect(page.getByTestId("lattice-pane")).toHaveCount(1);
  const first = page.getByTestId("lattice-pane").first();
  const firstId = await first.getAttribute("data-pane");

  // Split it: the new chat tiles to its right.
  await first.getByRole("button", { name: "Split with another agent" }).click();
  await page.getByRole("menuitem").filter({ hasText: /demo/i }).first().click();
  await expect(page.getByTestId("lattice-pane")).toHaveCount(2);
  const secondId = await page.locator(`[data-testid=lattice-pane]:not([data-pane="${firstId}"])`).getAttribute("data-pane");
  const second = page.locator(`[data-pane="${secondId}"]`);
  const [a, b] = [(await first.boundingBox())!, (await second.boundingBox())!];
  expect(b.x).toBeGreaterThan(a.x + a.width / 2);
  expect(Math.abs(b.y - a.y)).toBeLessThan(4);

  // The toolbar strip stacks a third.
  await page.getByTestId("stack-fake").click();
  await expect(page.getByTestId("lattice-pane")).toHaveCount(3);

  // One message to all three.
  await expect(page.getByTestId("broadcast-target")).toHaveCount(3);
  const thirdId = (await page.getByTestId("lattice-pane").evaluateAll((els) => els.map((e) => e.getAttribute("data-pane")))).find(
    (id) => id !== firstId && id !== secondId,
  );
  const third = page.locator(`[data-pane="${thirdId}"]`);
  await page.getByTestId("broadcast-target").nth(2).click(); // leave the newest out
  await page.getByTestId("broadcast-input").fill("hello everyone");
  await page.getByTestId("broadcast-input").press("Enter");
  await expect(first.getByTestId("transcript")).toContainText("hello everyone");
  await expect(second.getByTestId("transcript")).toContainText("hello everyone");
  await expect(third.getByTestId("transcript")).not.toContainText("hello everyone");
  // The demo agent asks before running a command; allow both.
  for (const pane of [first, second]) await pane.getByRole("button", { name: "Allow once" }).click({ timeout: 10_000 });
  await expect(first.getByTestId("chat-card")).toHaveAttribute("data-completed-turns", "1", { timeout: 15_000 });
  await expect(second.getByTestId("chat-card")).toHaveAttribute("data-completed-turns", "1", { timeout: 15_000 });
  if (shots) await page.screenshot({ path: `${shots}/lattice-collab.png` });

  // Pass the first chat's reply into the second's composer.
  await first.getByRole("button", { name: "Pass the last reply" }).click();
  await page.getByRole("menuitem").first().click();
  await expect(second.getByTestId("composer")).toHaveValue(/^From .*<reply>/s);

  // Ask everyone else to review it: both others get it.
  await first.getByRole("button", { name: "Pass the last reply" }).click();
  await page.getByRole("menuitem", { name: /to review it/ }).click();
  await expect(second.getByTestId("transcript")).toContainText("Review this", { timeout: 10_000 });
  await expect(third.getByTestId("transcript")).toContainText("Review this", { timeout: 10_000 });
  await app.close();
});
