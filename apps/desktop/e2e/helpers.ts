import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

export function tempDataDir(): string {
  return mkdtempSync(join(process.env.LATIS_TEST_TMP ?? tmpdir(), "latis-e2e-"));
}

export const fixturesRoot = fileURLToPath(new URL("../../../fixtures", import.meta.url));
export const claudeFixtures = fileURLToPath(new URL("../../../fixtures/claude-code", import.meta.url));

export async function launch(dataDir: string, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  // LATIS_E2E_EXECUTABLE runs the suite against a packaged build instead of out/.
  const executablePath = process.env.LATIS_E2E_EXECUTABLE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [appDir] }),
    env: {
      ...process.env,
      LATIS_DATA_DIR: dataDir,
      NODE_ENV: "production",
      LATIS_SKIP_ONBOARDING: "1",
      // Most specs predate the Conductor (M5); m5.spec.ts turns it on.
      LATIS_SKIP_CONDUCTOR: "1",
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[renderer]", m.text());
  });
  // The canvas, or the lattice when that's the saved layout.
  await page.waitForSelector("[aria-label='Canvas'], [data-testid='lattice']");
  return { app, page };
}

/** Makes the next folder picker return `folder` (the native dialog can't be driven by Playwright). */
export async function stubFolderPicker(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog;
  }, folder);
}
