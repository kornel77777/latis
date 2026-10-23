import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Connections, normalise } from "../../src/main/mcp/connections";
import { openDb } from "../../src/main/store/db";
import { WorkspaceStore } from "../../src/main/store/workspace";

// Stand-in for safeStorage: reversible, and visibly not plain text.
const crypto = {
  available: () => true,
  encrypt: (t: string) => Buffer.from(t, "utf8").reverse(),
  decrypt: (b: Buffer) => Buffer.from(b).reverse().toString("utf8"),
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "latis-conn-"));
  const store = new WorkspaceStore(openDb(join(dir, "latis.db")));
  const home = join(dir, "home");
  mkdirSync(home);
  return { store, home, conns: new Connections(store, crypto, home) };
}

describe("MCP connections", () => {
  it("stores env and headers encrypted and only returns their names", () => {
    const { store, conns } = setup();
    const c = conns.save({
      name: "github",
      transport: "http",
      url: "https://mcp.example/x",
      headers: { Authorization: "Bearer s3cret" },
      shared: true,
    });
    expect(c.headerKeys).toEqual(["Authorization"]);
    expect(JSON.stringify(c)).not.toContain("s3cret");
    expect(store.mcpRow(c.id)!.secret!.toString("utf8")).not.toContain("s3cret");
    expect(conns.configsFor([])).toEqual([
      { name: "github", transport: "http", url: "https://mcp.example/x", headers: { Authorization: "Bearer s3cret" } },
    ]);
    // Editing without secrets keeps them.
    conns.save({ id: c.id, name: "github", transport: "http", url: "https://mcp.example/y", shared: true });
    expect(conns.configsFor([])[0]!.headers).toEqual({ Authorization: "Bearer s3cret" });
  });

  it("passes shared connections to every chat and others only where attached", () => {
    const { conns } = setup();
    conns.save({ name: "shared", transport: "stdio", command: "npx", args: ["a"], shared: true });
    const own = conns.save({ name: "mine", transport: "stdio", command: "uvx", env: { KEY: "v" }, shared: false });
    expect(conns.configsFor([]).map((c) => c.name)).toEqual(["shared"]);
    expect(conns.configsFor([own.id]).map((c) => c.name)).toEqual(["shared", "mine"]);
  });

  it("refuses the reserved name, duplicates, and secrets without a keychain", () => {
    const { store, conns } = setup();
    expect(() => conns.save({ name: "latis", transport: "stdio", command: "x", shared: false })).toThrow(/reserved/);
    conns.save({ name: "a", transport: "stdio", command: "x", shared: false });
    expect(() => conns.save({ name: "a", transport: "stdio", command: "y", shared: false })).toThrow(/already/);
    const noKeychain = new Connections(store, { ...crypto, available: () => false });
    expect(() => noKeychain.save({ name: "b", transport: "stdio", command: "x", env: { K: "v" }, shared: false })).toThrow(/keychain/);
  });

  it("finds other apps' servers on Import and copies only the chosen ones", () => {
    const { conns, home } = setup();
    mkdirSync(join(home, ".cursor"));
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { fs: { command: "npx", args: ["-y", "fs"], env: { TOKEN: "t" } }, web: { url: "https://w.example/mcp" } },
      }),
    );
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n[mcp_servers.docs]\ncommand = "docs-mcp"\nargs = ["--stdio"]\n');
    const found = conns.scan();
    expect(found.map((f) => f.source)).toEqual(["Cursor", "Codex"]);
    expect(found[0]!.servers.map((s) => [s.name, s.transport, s.envKeys])).toEqual([
      ["fs", "stdio", ["TOKEN"]],
      ["web", "http", []],
    ]);
    const imported = conns.import(found[0]!.path, ["fs"]);
    expect(imported.map((c) => [c.name, c.shared, c.envKeys])).toEqual([["fs", false, ["TOKEN"]]]);
    expect(conns.scan()[0]!.servers.find((s) => s.name === "fs")!.exists).toBe(true);
    expect(() => conns.import("/etc/passwd", ["x"])).toThrow(/only imports/);
  });

  it("normalises the config shapes apps use", () => {
    expect(normalise("g", { httpUrl: "https://g", headers: { A: "b" } })).toEqual({
      name: "g",
      transport: "http",
      url: "https://g",
      headers: { A: "b" },
    });
    expect(normalise("bad name", { command: "x" })).toBeNull();
    expect(normalise("n", { foo: 1 })).toBeNull();
  });
});
