// Renders build/icon.svg to build/icon.png (1024²) with Electron; electron-builder makes .icns/.ico from it.
//   pnpm exec electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const svg = join(__dirname, "../build/icon.svg");
const png = join(__dirname, "../build/icon.png");
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    frame: false,
    transparent: true,
    paintWhenInitiallyHidden: true,
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${readFileSync(svg, "utf8")}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage();
  writeFileSync(png, image.resize({ width: 1024, height: 1024 }).toPNG());
  console.log(`wrote ${png} (${image.getSize().width}×${image.getSize().height} captured)`);
  app.exit(0);
});
