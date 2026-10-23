// Runs the "native" vitest project under Electron-as-Node, because better-sqlite3
// is compiled for Electron's ABI (see DECISIONS.md).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";

// Vitest's module cache misses new files matched by import.meta.glob (new migrations); start clean.
rmSync(new URL("../node_modules/.vitest-cache", import.meta.url), { recursive: true, force: true });

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const electron = require("electron");
const r = spawnSync(electron, ["node_modules/vitest/vitest.mjs", "run", "--project", "native", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(r.status ?? 1);
