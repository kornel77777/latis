import { expect, test, type Page } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, tempDataDir } from "./helpers";

// M4: the great UI.

const shots = process.env.LATIS_SCREENSHOTS;
type Api = { latis: LatisApi };

async function demoChats(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const api = (globalThis as unknown as Api).latis;
    const canvas = await api.invoke("canvas:load");
    for (let i = 0; i < count; i++)
      await api.invoke("chat:create", { canvasId: canvas.id, projectId: null, agentId: "fake", x: i * 500, y: 0 });
  }, n);
  await page.reload();
  await page.waitForSelector("[aria-label='Canvas']");
}

test("semantic zoom: full card, condensed card, status tile; drafts survive", async () => {
  const { app, page } = await launch(tempDataDir());
  await demoChats(page, 3);
  const first = page.getByTestId("chat-card").first();
  await page.keyboard.press("0");
  await expect(first.getByTestId("composer")).toBeVisible();
  await first.getByTestId("composer").fill("half-typed thought");
  await first.getByTestId("composer").press("Enter");
  await expect(first).toHaveAttribute("data-status", "needs-you", { timeout: 15_000 });
  await first.getByTestId("composer").fill("a draft to keep");

  // Zoom out with the keyboard: below 70% the cards condense; below 45% they become status tiles.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  const zoomOut = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press("-");
      await page.waitForTimeout(200);
    }
  };
  await zoomOut(2);
  await expect(page.locator("[data-zoom='condensed']").first()).toBeVisible();
  await zoomOut(3);
  const tile = page.locator("[data-zoom='tile']").first();
  await expect(tile).toBeVisible();
  await expect(tile.getByTestId("tile-state")).toHaveText("Needs you");
  await expect(tile).toContainText("waiting for you");
  if (shots) await page.screenshot({ path: `${shots}/m4-tiles.png` });

  // Clicking a tile zooms to that chat; the draft is still there.
  await tile.click();
  await expect(first.getByTestId("composer")).toHaveValue("a draft to keep", { timeout: 5000 });
  await app.close();
});
