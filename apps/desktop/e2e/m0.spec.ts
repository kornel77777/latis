import { expect, test } from "@playwright/test";
import { launch, tempDataDir } from "./helpers";

const shots = process.env.LATTIZ_SCREENSHOTS;

test("fake chat streams, asks permission, and everything survives a restart", async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);

  await page.getByTestId("empty-demo").click();
  const card = page.getByTestId("chat-card");
  await expect(card).toHaveCount(1);

  await card.getByTestId("composer").fill("swap the hero image");
  await card.getByTestId("send").click();
  await expect(card.getByTestId("user-message")).toHaveText("swap the hero image");

  // Streams, then stops at the permission request.
  await expect(card.getByTestId("permission")).toBeVisible({ timeout: 10_000 });
  await expect(card).toHaveAttribute("data-status", "needs-you");
  await expect(page.getByTestId("count-needs-you")).toContainText("1");
  if (shots) await page.screenshot({ path: `${shots}/needs-you.png` });

  await card.getByTestId("allow-once").click();
  await expect(card.getByTestId("turn-end")).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute("data-status", "done");
  await expect(card.getByTestId("assistant-message").last()).toContainText("notes/lattiz-demo.md");
  if (shots) await page.screenshot({ path: `${shots}/done.png` });

  // Move the card so we can check geometry persistence.
  const header = card.locator(".lattiz-drag");
  const before = await card.boundingBox();
  await header.hover();
  await page.mouse.down();
  await page.mouse.move(before!.x + 160, before!.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(700); // debounce 300 ms + write
  const moved = await card.boundingBox();
  const zoomBefore = await page.getByTestId("zoom-badge").textContent();

  await app.close();
  ({ app, page } = await launch(dataDir));

  const again = page.getByTestId("chat-card");
  await expect(again).toHaveCount(1);
  await expect(again.getByTestId("user-message")).toHaveText("swap the hero image");
  await expect(again.getByTestId("assistant-message").last()).toContainText("notes/lattiz-demo.md");
  await expect(again).toHaveAttribute("data-status", "done");
  const after = await again.boundingBox();
  expect(Math.abs(after!.x - moved!.x)).toBeLessThan(2);
  expect(Math.abs(after!.y - moved!.y)).toBeLessThan(2);
  await expect(page.getByTestId("zoom-badge")).toHaveText(zoomBefore!);
  await app.close();
});

test("a crashed agent moves the chat to error and can be restarted", async () => {
  const { app, page } = await launch(tempDataDir());
  await page.getByTestId("empty-demo").click();
  const card = page.getByTestId("chat-card");

  await card.getByTestId("composer").fill("build it /crash");
  await card.getByTestId("send").click();
  await expect(card).toHaveAttribute("data-status", "error", { timeout: 10_000 });
  await expect(card).toContainText("Agent process exited (code 3)");
  if (shots) await page.screenshot({ path: `${shots}/error.png` });

  await card.getByTestId("restart").click();
  await expect(card).toHaveAttribute("data-status", "idle");
  await card.getByTestId("composer").fill("try again");
  await card.getByTestId("send").click();
  await expect(card.getByTestId("permission")).toBeVisible({ timeout: 10_000 });
  await card.getByTestId("deny").click();
  await expect(card.getByTestId("turn-end")).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText("I won't run it");
  await app.close();
});

test("theme switches to light and persists", async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByTestId("empty-demo").click();
  await page.getByTestId("composer").fill("hello");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("permission")).toBeVisible({ timeout: 10_000 });
  if (shots) await page.screenshot({ path: `${shots}/light.png` });
  await app.close();
  ({ app, page } = await launch(dataDir));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await app.close();
});
