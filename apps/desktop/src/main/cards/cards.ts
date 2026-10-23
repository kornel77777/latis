import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { CanvasNode } from "@latis/shared";
import { cardData, cards, nodes } from "../store/schema";
import type { WorkspaceStore } from "../store/workspace";
import { BRIDGE_JS } from "./bridge";

// Cards (SPEC §12): small HTML apps on the canvas. Each is served from its own origin
// (card://<id>/), shown in a sandboxed iframe, and reaches Latis only through the bridge.

export const CARD_SIZE = { w: 420, h: 360 };
const REFRESH_TIMEOUT_MS = 60_000;
const DATA_LIMIT = 1_000_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

type CardRow = typeof cards.$inferSelect;

export interface CardDeps {
  confirm(message: string, detail: string, yes: string): Promise<boolean>;
}

/** The CSP a card is served with (§12.1); `allow` adds the origins the user granted. */
export function cardCsp(allow: string[]): string {
  return [
    "default-src 'self' card:",
    `connect-src ${allow.length ? allow.join(" ") : "'none'"}`,
    "img-src 'self' data: card:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' card: 'unsafe-inline'",
    "font-src 'self' data: card:",
    "base-uri 'none'",
  ].join("; ");
}

/** Exact origins only: scheme + host (+ port), https unless it's localhost. */
export function parseOrigins(list: unknown): string[] {
  if (!Array.isArray(list)) throw new Error('Pass a list of origins, like ["https://api.example.com"].');
  return list.map((o) => {
    let u: URL;
    try {
      u = new URL(String(o));
    } catch {
      throw new Error(`${String(o)} isn't an origin.`);
    }
    // `*` would be a wildcard in the CSP; only plain host names.
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) throw new Error(`${String(o)} isn't a plain origin.`);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error(`${u.origin} must use https.`);
    if (u.origin !== String(o).replace(/\/$/, "")) throw new Error(`Use the bare origin: ${u.origin}`);
    return u.origin;
  });
}

export class Cards {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly root: string,
    private readonly deps: CardDeps,
  ) {}

  dir(id: string): string {
    return join(this.root, id);
  }

  row(id: string): CardRow | undefined {
    return this.store.db.select().from(cards).where(eq(cards.id, id)).get();
  }

  private node(id: string): CanvasNode {
    const r = this.row(id);
    const n = r && this.store.getNode(r.nodeId);
    if (!r || !n) throw new Error(`No card with id ${id}.`);
    return n;
  }

  create(input: {
    canvasId: string;
    title: string;
    html: string;
    refreshScript?: string;
    x: number;
    y: number;
    parentId?: string | null;
    projectId?: string | null;
    gate?: string | null;
    files?: Record<string, string>;
  }): CanvasNode {
    const id = randomUUID();
    mkdirSync(this.dir(id), { recursive: true });
    for (const [name, body] of Object.entries(input.files ?? {})) this.writeFile(id, name, body);
    this.writeFile(id, "index.html", input.html);
    if (input.refreshScript) this.writeFile(id, "refresh.mjs", input.refreshScript);
    const nodeId = randomUUID();
    const now = Date.now();
    this.store.db.transaction((tx) => {
      tx.insert(nodes)
        .values({
          id: nodeId,
          canvasId: input.canvasId,
          projectId: input.projectId ?? null,
          parentId: input.parentId ?? null,
          type: "card",
          x: input.x,
          y: input.y,
          w: CARD_SIZE.w,
          h: CARD_SIZE.h,
          dataJson: JSON.stringify({ cardId: id, title: input.title, rev: 1, ...(input.gate && { gate: input.gate }) }),
          createdAt: now,
        })
        .run();
      tx.insert(cards)
        .values({ id, nodeId, title: input.title, gate: input.gate ?? null, createdAt: now })
        .run();
    });
    return this.store.getNode(nodeId)!;
  }

  private writeFile(id: string, name: string, body: string) {
    const target = normalize(join(this.dir(id), name));
    if (!target.startsWith(this.dir(id) + sep)) throw new Error(`${name} is outside the card's folder.`);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, body);
  }

  /** New HTML (and/or refresh script) from the agent; the card reloads. */
  update(id: string, patch: { html?: string; refreshScript?: string; title?: string }): CanvasNode {
    const n = this.node(id);
    if (patch.html !== undefined) this.writeFile(id, "index.html", patch.html);
    if (patch.refreshScript !== undefined) this.writeFile(id, "refresh.mjs", patch.refreshScript);
    if (patch.title) this.store.db.update(cards).set({ title: patch.title }).where(eq(cards.id, id)).run();
    this.store.updateNodeData(n.id, { rev: Number(n.data.rev ?? 1) + 1, ...(patch.title && { title: patch.title }) });
    return this.store.getNode(n.id)!;
  }

  // ── Data (§12.2) ───────────────────────────────────────────────────────────

  dataGet(id: string, key: string): unknown {
    const r = this.store.db
      .select()
      .from(cardData)
      .where(and(eq(cardData.cardId, id), eq(cardData.key, key)))
      .get();
    return r ? JSON.parse(r.valueJson) : null;
  }

  dataSet(id: string, key: string, value: unknown): void {
    if (typeof key !== "string" || !key || key.length > 200) throw new Error("Keys are non-empty strings.");
    const valueJson = JSON.stringify(value ?? null);
    if (valueJson.length > DATA_LIMIT) throw new Error("That value is over 1 MB.");
    this.store.db
      .insert(cardData)
      .values({ cardId: id, key, valueJson })
      .onConflictDoUpdate({ target: [cardData.cardId, cardData.key], set: { valueJson } })
      .run();
  }

  dataList(id: string): Record<string, unknown> {
    const rows = this.store.db.select().from(cardData).where(eq(cardData.cardId, id)).all();
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.valueJson) as unknown]));
  }

  // ── Refresh script (§12.2) ─────────────────────────────────────────────────

  /** Runs refresh.mjs (approved by the user first) and writes its JSON output into the card's data. */
  async refresh(id: string): Promise<{ updated: string[] }> {
    const row = this.row(id);
    if (!row) throw new Error(`No card with id ${id}.`);
    const file = join(this.dir(id), "refresh.mjs");
    if (!existsSync(file)) throw new Error("This card has no refresh script.");
    const script = readFileSync(file, "utf8");
    const hash = createHash("sha256").update(script).digest("hex");
    if (row.refreshHash !== hash) {
      const ok = await this.deps.confirm(
        `Let "${row.title}" run its refresh script?`,
        `It runs on this computer in the card's folder, without your environment's keys, for up to 60 s. Read it first:\n\n${script.slice(0, 3000)}${script.length > 3000 ? "\n…" : ""}`,
        "Run it",
      );
      if (!ok) throw new Error("The refresh script wasn't approved.");
      this.store.db.update(cards).set({ refreshHash: hash }).where(eq(cards.id, id)).run();
    }
    const out = await runScript(file, this.dir(id), JSON.stringify(this.dataList(id)));
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new Error("The refresh script didn't print JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The refresh script must print a JSON object.");
    for (const [k, v] of Object.entries(parsed)) this.dataSet(id, k, v);
    return { updated: Object.keys(parsed) };
  }

  // ── Network (§12.1) ────────────────────────────────────────────────────────

  network(id: string): string[] {
    return JSON.parse(this.row(id)?.networkJson ?? "[]") as string[];
  }

  /** The card asks; the user sees exactly which origins and decides. */
  async requestNetwork(id: string, origins: unknown): Promise<boolean> {
    const row = this.row(id);
    if (!row) throw new Error(`No card with id ${id}.`);
    const list = parseOrigins(origins);
    const have = this.network(id);
    const fresh = list.filter((o) => !have.includes(o));
    if (!fresh.length) return true;
    const ok = await this.deps.confirm(
      `Let "${row.title}" connect to the internet?`,
      `It asks to reach only:\n\n${fresh.join("\n")}\n\nIt still can't read your files, keys, chats or other cards.`,
      "Allow",
    );
    if (!ok) return false;
    this.store.db
      .update(cards)
      .set({ networkJson: JSON.stringify([...have, ...fresh]) })
      .where(eq(cards.id, id))
      .run();
    return true;
  }

  // ── card:// (§12.1) ────────────────────────────────────────────────────────

  private snapshots = new Map<string, { cardId: string; json: string }>();

  /** A one-time token that serves the card with a read-only copy of its data (PDF export). */
  snapshot(id: string, extra: { theme: unknown; usage?: unknown }): string {
    const token = randomUUID();
    this.snapshots.set(token, { cardId: id, json: JSON.stringify({ data: this.dataList(id), ...extra }) });
    setTimeout(() => this.snapshots.delete(token), 60_000);
    return token;
  }

  /** Serves card://<id>/<path>. Only files inside that card's folder; HTML gets the bridge. */
  serve(url: string): Response {
    const u = new URL(url);
    const id = u.hostname;
    const snap = this.snapshots.get(u.searchParams.get("snapshot") ?? "");
    if (!this.row(id)) return new Response("Not found", { status: 404 });
    const headers = { "content-security-policy": cardCsp(this.network(id)), "x-content-type-options": "nosniff" };
    const path = decodeURIComponent(u.pathname).replace(/^\/+/, "") || "index.html";
    if (path === "__latis.js") return new Response(BRIDGE_JS, { headers: { ...headers, "content-type": MIME[".js"]! } });
    const file = normalize(join(this.dir(id), path));
    if (!file.startsWith(this.dir(id) + sep) || !existsSync(file) || path === "refresh.mjs")
      return new Response("Not found", { status: 404, headers });
    const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    let body: Buffer | string = readFileSync(file);
    if (type.startsWith("text/html")) {
      const html = body.toString("utf8");
      // </script> can't appear inside a JSON string literal here, so escape "<".
      const pre = snap?.cardId === id ? `<script>window.__latisSnapshot=${snap.json.replaceAll("<", "\\u003c")}</script>` : "";
      const tag = `${pre}<script src="card://${id}/__latis.js"></script>`;
      body = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`) : `${tag}${html}`;
    }
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { headers: { ...headers, "content-type": type } });
  }
}

/** node refresh.mjs, with no inherited secrets: only PATH, HOME and the locale. */
function runScript(file: string, cwd: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
    for (const k of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "LANG", "TMPDIR", "TEMP"]) if (process.env[k]) env[k] = process.env[k];
    const child = spawn(process.execPath, [file], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The refresh script took longer than 60 s."));
    }, REFRESH_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`The refresh script failed: ${err.trim().split("\n").at(-1) ?? `exit ${code}`}`));
    });
    child.stdin.end(input);
  });
}
