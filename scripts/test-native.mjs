// Runs the "native" vitest project under Electron-as-Node, because better-sqlite3
// is compiled for Electron's ABI (see DECISIONS.md).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const electron = require("electron");
const r = spawnSync(electron, ["node_modules/vitest/vitest.mjs", "run", "--project", "native", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(r.status ?? 1);
