import { app } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";

/** Data directory per SPEC §7. `LATIS_DATA_DIR` overrides it (tests, multiple profiles). */
export function resolveDataDir(): string {
  if (process.env.LATIS_DATA_DIR) return process.env.LATIS_DATA_DIR;
  switch (process.platform) {
    case "win32":
      return join(app.getPath("appData"), "Latis");
    case "darwin":
      return join(homedir(), "Library", "Application Support", "Latis");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "latis");
  }
}
