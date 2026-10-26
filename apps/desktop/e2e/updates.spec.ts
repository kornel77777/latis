import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import type { LatisApi } from "@latis/shared";
import { launch, tempDataDir } from "./helpers";

// The release check (main/updates.ts) against a local stand-in for the GitHub releases API.

type Api = { latis: LatisApi };

test("a newer release shows in the status bar and Settings → General; it can be dismissed and turned off", async () => {
  let checks = 0;
  const server = createServer((_req, res) => {
    checks++;
    const port = (server.address() as AddressInfo).port;
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ tag_name: "v9.0.0", name: "Latis 9", html_url: `http://127.0.0.1:${port}/releases/v9.0.0`, published_at: null }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const feed = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`;
  const { app, page } = await launch(tempDataDir(), { LATIS_UPDATE_FEED: feed });

  const notice = page.getByTestId("update-available");
  await expect(notice).toContainText("Latis 9.0.0 is out", { timeout: 10_000 });
  await expect(notice.getByRole("link")).toHaveAttribute("href", /\/releases\/v9\.0\.0$/);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: /Settings…/ }).click();
  await page.getByRole("button", { name: "General" }).click();
  const general = page.getByTestId("general-settings");
  await expect(general).toContainText("Latis 9.0.0 is out.");
  await expect(general.getByTestId("update-link")).toContainText("Download 9.0.0");
  const before = checks;
  await general.getByTestId("update-check").click();
  await expect.poll(() => checks).toBeGreaterThan(before);
  await general.getByRole("checkbox", { name: /Check for new versions/ }).uncheck();
  await expect
    .poll(() => page.evaluate(() => (globalThis as unknown as Api).latis.invoke("prefs:get").then((p) => p.checkUpdates)))
    .toBe(false);
  await page.keyboard.press("Escape");

  await notice.getByRole("button", { name: "Dismiss the update notice" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.getByLabel("Status")).toContainText(/v\d+\.\d+\.\d+/);
  await app.close();
  server.close();
});
