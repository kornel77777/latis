import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateLegacyDataDir } from "../../src/main/paths";

describe("migrateLegacyDataDir", () => {
  it("moves the Latis folder to Lattiz once, renaming the database", () => {
    const root = mkdtempSync(join(tmpdir(), "lattiz-migrate-"));
    const legacy = join(root, "Latis");
    const next = join(root, "Lattiz");
    mkdirSync(join(legacy, "skills"), { recursive: true });
    writeFileSync(join(legacy, "latis.db"), "db");
    writeFileSync(join(legacy, "latis.db-wal"), "wal");
    writeFileSync(join(legacy, "skills", "review.md"), "skill");

    expect(migrateLegacyDataDir(next, legacy)).toBe(true);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(next, "lattiz.db"), "utf8")).toBe("db");
    expect(readFileSync(join(next, "lattiz.db-wal"), "utf8")).toBe("wal");
    expect(existsSync(join(next, "latis.db"))).toBe(false);
    expect(readFileSync(join(next, "skills", "review.md"), "utf8")).toBe("skill");
    // Once is enough.
    expect(migrateLegacyDataDir(next, legacy)).toBe(false);
  });

  it("leaves an existing Lattiz folder alone", () => {
    const root = mkdtempSync(join(tmpdir(), "lattiz-migrate-"));
    mkdirSync(join(root, "Latis"));
    mkdirSync(join(root, "Lattiz"));
    expect(migrateLegacyDataDir(join(root, "Lattiz"), join(root, "Latis"))).toBe(false);
    expect(existsSync(join(root, "Latis"))).toBe(true);
  });
});
