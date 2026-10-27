import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// Settings → Data → Export (SPEC §8.11, §13): a copy of the workspace without secrets.

/** Folders that are the user's work. Left out: accounts/ (agent sign-ins), run/ (tokens), electron/ (browser profile), logs. */
const INCLUDED = ["skills", "conductor", "cards", "agents", "projects"];

const README = `Lattiz workspace export

lattiz.db holds the canvas, chats and their transcripts, notes, flows and settings.
Secrets were removed: the Anthropic API key and the encrypted values of MCP connections
(add them again after restoring). Agent sign-ins and Lattiz's browser profile aren't included.

To restore, quit Lattiz and copy these files into its data folder (Settings → Data → Open).
`;

const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

/** Writes "Lattiz export <date>" inside `targetDir` and returns its path. */
export function exportWorkspace(dataDir: string, targetDir: string, now = new Date()): string {
  let out = join(targetDir, `Lattiz export ${stamp(now)}`);
  for (let n = 2; existsSync(out); n++) out = join(targetDir, `Lattiz export ${stamp(now)} (${n})`);
  mkdirSync(out, { recursive: true });

  // A consistent copy of the database even while Lattiz writes to it, then the secrets go.
  const db = join(out, "lattiz.db");
  const live = new Database(join(dataDir, "lattiz.db"), { readonly: true, fileMustExist: true });
  try {
    live.prepare("VACUUM INTO ?").run(db);
  } finally {
    live.close();
  }
  const copy = new Database(db);
  try {
    copy.prepare("DELETE FROM settings WHERE key = 'claudeApiKey'").run();
    copy.prepare("UPDATE mcp_servers SET secret = NULL").run();
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }

  for (const name of INCLUDED) {
    const from = join(dataDir, name);
    if (existsSync(from)) cpSync(from, join(out, name), { recursive: true });
  }
  writeFileSync(join(out, "README.txt"), README);
  return out;
}
