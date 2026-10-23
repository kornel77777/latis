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

test("notes: create with N, edit markdown, persist; delete with undo; projects: rename, colour, remove, locate", async () => {
  const { mkdirSync, writeFileSync, renameSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { stubFolderPicker } = await import("./helpers");
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);

  // N makes a note in edit mode; Escape shows the rendered markdown.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("n");
  const note = page.getByTestId("note");
  await note.getByTestId("note-editor").fill("# Launch plan\n\n- [ ] ship it\n\n`code`");
  await page.keyboard.press("Escape");
  await expect(note.getByTestId("note-preview").locator("h3")).toHaveText("Launch plan");
  await expect(note.getByTestId("note-preview").locator("input[type=checkbox]")).toHaveCount(1);

  // Delete with Backspace, then undo.
  await note.click();
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("note")).toHaveCount(1);

  // A project: rename, recolour, remove (soft) and undo.
  const repo = join(dataDir, "shop");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# shop\n");
  await stubFolderPicker(app, repo);
  await page.getByTestId("open-folder").click();
  const frame = page.getByTestId("project-frame");
  await frame.getByTestId("frame-name").dblclick();
  await frame.getByLabel("Project name").fill("Shop");
  await frame.getByLabel("Project name").press("Enter");
  await expect(frame.getByTestId("frame-name")).toHaveText("Shop");
  await frame.getByTestId("frame-menu").click();
  await page.getByRole("button", { name: "pink" }).click();
  await page.keyboard.press("Escape");
  await frame.getByTestId("frame-menu").click();
  await page.getByRole("menuitem", { name: /Remove project/ }).click();
  await expect(page.getByTestId("project-frame")).toHaveCount(0);
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("project-frame")).toHaveText(/Shop/);
  await app.close();

  // Everything persisted; the moved folder shows "Folder missing" with Locate.
  renameSync(repo, join(dataDir, "shop-moved"));
  ({ app, page } = await launch(dataDir));
  // Off-screen nodes aren't rendered (virtualisation); fit everything first.
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Shift+1");
  await expect(page.getByTestId("note")).toContainText("Launch plan");
  await expect(page.getByTestId("project-frame")).toContainText("Folder missing");
  await stubFolderPicker(app, join(dataDir, "shop-moved"));
  await page.getByTestId("frame-locate").click();
  await expect(page.getByTestId("project-frame")).not.toContainText("Folder missing");
  await expect(page.getByTestId("project-frame")).toContainText("shop-moved");
  await app.close();
});

test("command palette: run actions, find chats by what was said, files, and restore deleted items", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { stubFolderPicker } = await import("./helpers");
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  const palette = page.getByTestId("palette");
  const input = palette.getByTestId("palette-input");

  // An action: New note.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("new note");
  await expect(palette.getByTestId("palette-item").first()).toContainText("New note");
  await input.press("Enter");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Content search: a chat found by something said in it, not its title.
  await demoChats(page, 1);
  const chat = page.getByTestId("chat-card").first();
  await chat.getByTestId("composer").fill("please tune the zanzibar pricing");
  await chat.getByTestId("composer").press("Enter");
  await expect(chat).toHaveAttribute("data-status", "needs-you", { timeout: 15_000 });
  await page.getByTestId("open-palette").click();
  await input.fill("zanzib");
  const hit = palette.locator("[data-group='In chats and notes']").first();
  await expect(hit).toContainText("zanzibar");
  if (shots) await page.screenshot({ path: `${shots}/m4-palette.png` });
  await input.press("Escape");

  // Files in the active project.
  const repo = join(dataDir, "shop");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "checkout-flow.ts"), "export {};\n");
  await stubFolderPicker(app, repo);
  await page.getByTestId("open-folder").click();
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("checkoutflow");
  await expect(palette.locator("[data-group='Files']").first()).toContainText("src/checkout-flow.ts");
  await input.press("Escape");

  // Restore: pick the note from the palette (selects it), delete it, then bring it back.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("untitled note");
  await input.press("Enter");
  await page.locator(".react-flow__pane").focus();
  await page.keyboard.press("Backspace");
  await expect(page.getByTestId("note")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("restore note");
  await input.press("Enter");
  await expect(page.getByTestId("note")).toHaveCount(1);
  await app.close();
});

test("focus mode: selected chats fill the screen in grid, stage and columns; saved as a tab; distraction-free", async () => {
  const dataDir = tempDataDir();
  let { app, page } = await launch(dataDir);
  await demoChats(page, 3);
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("f");
  const view = page.getByTestId("focus-view");
  await expect(view).toHaveAttribute("data-layout", "columns");
  await expect(view.getByTestId("chat-card")).toHaveCount(3);
  if (shots) await page.screenshot({ path: `${shots}/m4-focus.png` });
  await view.getByTestId("layout-stage").click();
  await expect(view).toHaveAttribute("data-layout", "stage");
  await view.getByTestId("layout-grid").click();
  await expect(view).toHaveAttribute("data-layout", "grid");

  // A chat is usable in focus mode.
  await view.getByTestId("composer").first().fill("from focus mode");
  await view.getByTestId("composer").first().press("Enter");
  await expect(view.getByTestId("chat-card").first()).toHaveAttribute("data-status", "needs-you", { timeout: 15_000 });

  // Esc back to the canvas; the view stays as a tab and survives a restart.
  await page.keyboard.press("Escape"); // leaves the composer
  await page.keyboard.press("Escape"); // leaves focus mode
  await expect(page.getByTestId("focus-view")).toHaveCount(0);
  await expect(page.getByTestId("view-tab")).toHaveCount(1);
  await app.close();
  ({ app, page } = await launch(dataDir));
  await page.getByTestId("view-tab").getByRole("button").first().click();
  await expect(page.getByTestId("focus-view")).toHaveAttribute("data-layout", "grid");

  // Distraction-free hides the sidebar, tabs and status bar.
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(page.getByLabel("Sidebar")).toHaveCount(0);
  await expect(page.getByLabel("Status")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(page.getByLabel("Sidebar")).toHaveCount(1);
  await app.close();
});
