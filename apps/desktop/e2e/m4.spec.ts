/// <reference lib="dom" />

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

test("browser dock: dev-server detection, nothing-running page, and the element picker into a chat", async () => {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><title>Shop</title><body style="margin:0"><button id="buy" class="cta big" style="margin:40px;padding:12px 20px;background:#0f9f8f;color:white;border-radius:8px">Buy now</button></body>`,
    );
  });
  // 3009: one of the ports Latis scans (§9.7 AC1); skip detection if something else already uses it.
  const port = await new Promise<number>((resolve) => {
    server.once("error", () => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
    server.listen(3009, "127.0.0.1", () => resolve(3009));
  });
  const { app, page } = await launch(tempDataDir());
  await demoChats(page, 1);
  await page.keyboard.press("ControlOrMeta+Shift+b");
  const panel = page.getByTestId("browser-panel");
  await expect(panel).toBeVisible();

  // Nothing listening → a clear page with a way out (§9.7 AC4).
  await panel.getByTestId("browser-url").fill("localhost:3999");
  await panel.getByTestId("browser-url").press("Enter");
  await expect(panel.getByTestId("browser-error")).toContainText("Nothing running on :3999");

  await panel.getByTestId("browser-url").fill(`localhost:${port}`);
  await panel.getByTestId("browser-url").press("Enter");
  await expect(panel.getByTestId("browser-error")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.querySelector("[data-testid=browser-url]")?.getAttribute("value") ??
          (document.querySelector("[data-testid=browser-url]") as HTMLInputElement).value,
      ),
    )
    .toContain(`${port}`);
  if (port === 3009) await expect(panel).toContainText(":3009");

  // Pick: start picking, then "click" the button inside the page through Electron's input events.
  await panel.getByTestId("pick-element").click();
  await expect(panel.getByTestId("pick-element")).toContainText("Click an element");
  await app.evaluate(async ({ webContents }, p) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(`:${p}`))!;
    const r = (await wc.executeJavaScript(
      `(() => { const b = document.getElementById("buy").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
    )) as { x: number; y: number };
    wc.sendInputEvent({ type: "mouseMove", x: Math.round(r.x), y: Math.round(r.y) });
    await new Promise((res) => setTimeout(res, 100));
    wc.sendInputEvent({ type: "mouseDown", x: Math.round(r.x), y: Math.round(r.y), button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: Math.round(r.x), y: Math.round(r.y), button: "left", clickCount: 1 });
  }, port);
  const picked = panel.getByTestId("picked");
  await expect(picked).toContainText("#buy");
  await expect(picked.locator("img")).toBeVisible();
  await picked.getByTestId("send-picked").click();
  await page.getByRole("menuitem", { name: "Demo chat" }).click();

  // The chat's composer has the element's HTML, selector and styles, plus its screenshot.
  const chat = page.getByTestId("chat-card").first();
  await expect(chat.getByTestId("composer")).toHaveValue(/Selector: `#buy`[\s\S]*<button id="buy"[\s\S]*background-color/);
  await expect(chat.getByTestId("attachments").locator("img")).toHaveCount(1);
  await app.close();
  server.close();
});

test("appearance, the getting-started checklist, and accessibility announcements", async () => {
  const { app, page } = await launch(tempDataDir());
  await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("prefs:set", { checklist: [] }));
  await demoChats(page, 1);
  const checklist = page.getByTestId("checklist");
  await expect(checklist).toContainText("0 of 5");

  // Appearance: accent, chat text size, glass cards, no grid.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: /Settings…/ }).click();
  await page.getByRole("button", { name: "Appearance" }).click();
  const appearance = page.getByTestId("appearance");
  await appearance.getByRole("radio", { name: "Ember" }).click();
  await appearance.getByRole("radio", { name: "Glass" }).click();
  await appearance.getByRole("radio", { name: "None" }).click();
  await appearance.getByLabel("Chat text size").fill("17");
  const root = (prop: string) => page.evaluate((p) => getComputedStyle(document.documentElement).getPropertyValue(p).trim(), prop);
  await expect.poll(() => root("--accent")).toBe("#fb923c");
  await expect.poll(() => root("--chat-text")).toBe("17px");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.cardStyle)).toBe("glass");
  await page.keyboard.press("Escape");
  await expect(page.locator(".react-flow__background")).toHaveCount(0);

  // A permission request is announced to screen readers and ticks nothing until approved.
  const chat = page.getByTestId("chat-card").first();
  await chat.getByTestId("composer").fill("go");
  await chat.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("announcer")).toContainText("needs you", { timeout: 15_000 });
  await chat.getByTestId("allow-once").click();
  await expect(checklist).toContainText("2 of 5");

  // Keyboard: Enter on a focused chat goes to its composer; the palette ticks its step.
  await page.locator(".react-flow__node").first().focus();
  await page.keyboard.press("Enter");
  await expect(chat.getByTestId("composer")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("Escape");
  await expect(checklist).toContainText("3 of 5");
  await checklist.getByRole("button", { name: "Dismiss getting started" }).click();
  await expect(checklist).toHaveCount(0);
  await app.close();
});
