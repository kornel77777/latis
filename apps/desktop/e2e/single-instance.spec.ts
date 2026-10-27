import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launch, tempDataDir } from "./helpers";

// Opening Lattiz while it already runs (Dock, Finder, Spotlight) brings the running window forward;
// the second copy exits at once instead of starting on the same data folder.

const appDir = fileURLToPath(new URL("..", import.meta.url));

test("a second launch exits and brings the running window forward", async () => {
  const dataDir = tempDataDir();
  const env = { LATTIZ_SINGLE_INSTANCE: "1" };
  const { app } = await launch(dataDir, env);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.minimize());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true);

  const executable = await app.evaluate(() => process.execPath);
  const second = spawn(executable, [appDir], {
    env: { ...process.env, LATTIZ_DATA_DIR: dataDir, NODE_ENV: "production", ...env },
    stdio: "ignore",
  });
  const code = await new Promise<number | null>((resolve) => second.on("exit", resolve));
  expect(code).toBe(0);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(false);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.close();
});
