import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, stubFolderPicker, tempDataDir } from "./helpers";

type Api = { latis: LatisApi };

test("Settings → Data shows the folder and exports the workspace; Report a problem builds scrubbed diagnostics", async () => {
  const dataDir = tempDataDir();
  const { app, page } = await launch(dataDir);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: /Settings…/ }).click();
  await page.getByRole("button", { name: "Data", exact: true }).click();
  const data = page.getByTestId("data-settings");
  await expect(data).toContainText(dataDir);
  await expect(data.getByRole("link", { name: "What leaves your computer" })).toHaveAttribute("href", /docs\/privacy\.md$/);

  const target = mkdtempSync(join(tmpdir(), "latis-e2e-export-"));
  await stubFolderPicker(app, target);
  await data.getByTestId("data-export").click();
  await expect.poll(() => readdirSync(target).length, { timeout: 10_000 }).toBe(1);
  const out = join(target, readdirSync(target)[0]!);
  expect(existsSync(join(out, "latis.db"))).toBe(true);
  expect(existsSync(join(out, "README.txt"))).toBe(true);
  expect(existsSync(join(out, "electron"))).toBe(false);

  const report = await page.evaluate(() => (globalThis as unknown as Api).latis.invoke("app:report"));
  expect(report.diagnostics).toMatch(/^Latis \d+\.\d+\.\d+ · /);
  expect(report.diagnostics).not.toContain(dataDir.split("/").slice(0, 3).join("/") + "/");
  expect(report.issueUrl).toMatch(/^https:\/\/github\.com\/kornel77777\/latis\/issues\/new\?/);
  await app.close();
});
