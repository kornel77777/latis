import { app } from "electron";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Data directory per SPEC §7. `LATTIZ_DATA_DIR` overrides it (tests, multiple profiles). */
export function resolveDataDir(): string {
  if (process.env.LATTIZ_DATA_DIR) return process.env.LATTIZ_DATA_DIR;
  return defaultDataDir("Lattiz");
}

function defaultDataDir(name: string): string {
  switch (process.platform) {
    case "win32":
      return join(app.getPath("appData"), name);
    case "darwin":
      return join(homedir(), "Library", "Application Support", name);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), name.toLowerCase());
  }
}

/** Where the data lived while the app was called Latis (up to 0.1.2). */
export function legacyDataDir(): string {
  return defaultDataDir("Latis");
}

/**
 * Moves the Latis data folder to the Lattiz one, once (DECISIONS 2026-10-27): chats, projects, settings and
 * sign-in folders come along. Does nothing when the new folder already exists or there's nothing to move.
 */
export function migrateLegacyDataDir(dataDir: string, legacy: string): boolean {
  if (existsSync(dataDir) || !existsSync(legacy)) return false;
  renameSync(legacy, dataDir);
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = join(dataDir, `latis.db${suffix}`);
    if (existsSync(from)) renameSync(from, join(dataDir, `lattiz.db${suffix}`));
  }
  return true;
}
