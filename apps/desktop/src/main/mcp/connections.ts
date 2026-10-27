import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import type { McpConnection, McpConnectionInput, McpImportCandidate, McpServerConfig } from "@lattiz/shared";
import type { WorkspaceStore } from "../store/workspace";

// MCP connections (SPEC §9.15). Env values and headers can hold API keys, so they're stored
// encrypted with the OS keychain (Electron safeStorage) and only decrypted to start an agent.

export interface Crypto {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(buf: Buffer): string;
}

interface Secrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

type Row = ReturnType<WorkspaceStore["mcpRows"]>[number];

/** Names Lattiz uses itself, so a connection can't shadow the workspace tools. */
export const RESERVED = new Set(["lattiz"]);

export class Connections {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly crypto: Crypto,
    private readonly home = homedir(),
  ) {}

  private secrets(row: Row): Secrets {
    if (!row.secret) return { env: {}, headers: {} };
    try {
      return JSON.parse(this.crypto.decrypt(row.secret)) as Secrets;
    } catch (err) {
      console.warn(`[mcp] couldn't decrypt the secrets of ${row.name}`, err);
      return { env: {}, headers: {} };
    }
  }

  private toConnection(row: Row): McpConnection {
    const s = this.secrets(row);
    return {
      id: row.id,
      name: row.name,
      transport: row.transport === "http" ? "http" : "stdio",
      command: row.command,
      args: JSON.parse(row.argsJson) as string[],
      url: row.url,
      envKeys: Object.keys(s.env),
      headerKeys: Object.keys(s.headers),
      shared: row.shared,
    };
  }

  list(): McpConnection[] {
    return this.store.mcpRows().map((r) => this.toConnection(r));
  }

  save(input: McpConnectionInput): McpConnection {
    if (RESERVED.has(input.name.toLowerCase())) throw new Error(`"${input.name}" is reserved for Lattiz's own tools. Pick another name.`);
    if (input.transport === "stdio" && !input.command?.trim()) throw new Error("A stdio connection needs a command.");
    if (input.transport === "http" && !input.url) throw new Error("An HTTP connection needs a URL.");
    const clash = this.store.mcpRows().find((r) => r.name === input.name && r.id !== input.id);
    if (clash) throw new Error(`There's already a connection called ${input.name}.`);
    const prev = input.id ? this.store.mcpRow(input.id) : undefined;
    if (input.id && !prev) throw new Error("That connection no longer exists.");
    const old = prev ? this.secrets(prev) : { env: {}, headers: {} };
    const secrets: Secrets = { env: input.env ?? old.env, headers: input.headers ?? old.headers };
    const hasSecrets = Object.keys(secrets.env).length + Object.keys(secrets.headers).length > 0;
    if (hasSecrets && !this.crypto.available())
      throw new Error(
        "This computer has no keychain Lattiz can use, so it can't store keys safely. Remove the env values and headers, or set up a keyring.",
      );
    const row = this.store.saveMcpRow({
      id: input.id ?? randomUUID(),
      name: input.name,
      transport: input.transport,
      command: input.transport === "stdio" ? input.command!.trim() : null,
      argsJson: JSON.stringify(input.transport === "stdio" ? (input.args ?? []) : []),
      url: input.transport === "http" ? input.url! : null,
      secret: hasSecrets ? this.crypto.encrypt(JSON.stringify(secrets)) : null,
      shared: input.shared,
      ...(prev && { createdAt: prev.createdAt }),
    });
    return this.toConnection(row);
  }

  remove(id: string): void {
    this.store.removeMcpRow(id);
  }

  /** What an agent gets: every shared connection plus the ones attached to the chat. */
  configsFor(attached: string[]): McpServerConfig[] {
    return this.store
      .mcpRows()
      .filter((r) => r.shared || attached.includes(r.id))
      .map((r) => {
        const s = this.secrets(r);
        return r.transport === "http"
          ? { name: r.name, transport: "http" as const, url: r.url!, headers: s.headers }
          : { name: r.name, transport: "stdio" as const, command: r.command!, args: JSON.parse(r.argsJson) as string[], env: s.env };
      });
  }

  // ── Import (§9.15 AC2) ─────────────────────────────────────────────────────

  /** Config files other apps keep MCP servers in. Read only when the user clicks Import. */
  sources(): { source: string; path: string; format: "json" | "codex" | "vscode" }[] {
    const h = this.home;
    const appData =
      process.platform === "darwin"
        ? join(h, "Library", "Application Support")
        : process.platform === "win32"
          ? (process.env.APPDATA ?? join(h, "AppData", "Roaming"))
          : join(h, ".config");
    return [
      { source: "Claude Desktop", path: join(appData, "Claude", "claude_desktop_config.json"), format: "json" },
      { source: "Claude Code", path: join(h, ".claude.json"), format: "json" },
      { source: "Cursor", path: join(h, ".cursor", "mcp.json"), format: "json" },
      { source: "Gemini CLI", path: join(h, ".gemini", "settings.json"), format: "json" },
      { source: "Codex", path: join(h, ".codex", "config.toml"), format: "codex" },
      { source: "VS Code", path: join(appData, "Code", "User", "mcp.json"), format: "vscode" },
    ];
  }

  private read(path: string): ImportedServer[] {
    const src = this.sources().find((s) => s.path === path);
    if (!src) throw new Error("Lattiz only imports from the config files it lists.");
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    // Only the MCP server section is read; the rest of the file is ignored.
    const servers =
      src.format === "codex"
        ? (parseToml(raw).mcp_servers as Record<string, unknown> | undefined)
        : src.format === "vscode"
          ? (JSON.parse(raw) as { servers?: Record<string, unknown> }).servers
          : (JSON.parse(raw) as { mcpServers?: Record<string, unknown> }).mcpServers;
    return Object.entries(servers ?? {}).flatMap(([name, v]) => {
      const s = normalise(name, v);
      return s ? [s] : [];
    });
  }

  scan(): McpImportCandidate[] {
    const names = new Set(this.store.mcpRows().map((r) => r.name));
    return this.sources().flatMap(({ source, path }) => {
      let servers: ImportedServer[];
      try {
        servers = this.read(path);
      } catch (err) {
        console.warn(`[mcp] couldn't read ${path}`, err);
        return [];
      }
      if (!servers.length) return [];
      return [
        {
          source,
          path,
          servers: servers.map((s) => ({
            name: s.name,
            transport: s.transport,
            command: s.command ?? null,
            args: s.args ?? [],
            url: s.url ?? null,
            envKeys: Object.keys(s.env ?? {}),
            headerKeys: Object.keys(s.headers ?? {}),
            exists: names.has(s.name),
          })),
        },
      ];
    });
  }

  import(path: string, names: string[]): McpConnection[] {
    const existing = new Set(this.store.mcpRows().map((r) => r.name));
    return this.read(path)
      .filter((s) => names.includes(s.name) && !existing.has(s.name) && !RESERVED.has(s.name.toLowerCase()))
      .map((s) =>
        this.save({
          name: s.name,
          transport: s.transport,
          ...(s.command && { command: s.command }),
          ...(s.args && { args: s.args }),
          ...(s.url && { url: s.url }),
          ...(s.env && { env: s.env }),
          ...(s.headers && { headers: s.headers }),
          shared: false,
        }),
      );
  }
}

interface ImportedServer {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

const strings = (o: unknown): Record<string, string> | undefined => {
  if (!o || typeof o !== "object") return undefined;
  const entries = Object.entries(o).filter((e): e is [string, string] => typeof e[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** The shapes the various apps use: {command,args,env} or {url|httpUrl|serverUrl, headers|http_headers}. */
export function normalise(name: string, v: unknown): ImportedServer | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || !v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const url = [o.url, o.httpUrl, o.serverUrl].find((x): x is string => typeof x === "string");
  if (url) {
    // SSE-only servers aren't supported by every agent; they're imported as HTTP and may not connect.
    const headers = strings(o.headers) ?? strings(o.http_headers);
    return { name, transport: "http", url, ...(headers && { headers }) };
  }
  if (typeof o.command !== "string") return null;
  const args = Array.isArray(o.args) ? o.args.filter((a): a is string => typeof a === "string") : [];
  const env = strings(o.env);
  return { name, transport: "stdio", command: o.command, args, ...(env && { env }) };
}
