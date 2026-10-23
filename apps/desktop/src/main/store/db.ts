import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// drizzle-kit generates the SQL; we bundle it and apply it ourselves, tracked by
// PRAGMA user_version, so packaged builds need no migrations folder on disk.
const migrationFiles = import.meta.glob<string>("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

export const migrations = Object.entries(migrationFiles)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, sql]) => ({ name, sql }));

export function migrate(sqlite: Database.Database, list = migrations): void {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  list.slice(current).forEach((m, i) => {
    const apply = sqlite.transaction(() => {
      for (const stmt of m.sql.split("--> statement-breakpoint")) {
        if (stmt.trim()) sqlite.exec(stmt);
      }
      sqlite.pragma(`user_version = ${current + i + 1}`);
    });
    apply();
  });
}

export function openDb(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}
