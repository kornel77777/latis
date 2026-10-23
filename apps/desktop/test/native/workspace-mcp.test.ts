import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentAdapter, AgentEvent, AgentSession, CanvasNode, ChatSummary, FocusView, Project } from "@latis/shared";
import { SessionSupervisor } from "../../src/main/agents/supervisor";
import { WorkspaceMcpServer } from "../../src/main/mcp/server";
import { WorkspaceService } from "../../src/main/mcp/workspace";
import { Cards, cardCsp } from "../../src/main/cards/cards";
import { openDb } from "../../src/main/store/db";
import { EventLog } from "../../src/main/store/event-log";
import { WorkspaceStore } from "../../src/main/store/workspace";

/** Each message gets "Reviewed: <text>" after `delay` ms. */
function replyAdapter(delay = 30): AgentAdapter {
  const session = (): AgentSession => {
    const listeners = new Set<(e: AgentEvent) => void>();
    const emit = (e: AgentEvent) => listeners.forEach((l) => l(e));
    return {
      id: "s",
      async send({ text }) {
        setTimeout(() => {
          emit({ type: "message.completed", text: `Reviewed: ${text}` });
          emit({ type: "turn.completed", status: "ok", durationMs: delay });
        }, delay);
      },
      async interrupt() {},
      async respond() {},
      onEvent: (l) => (listeners.add(l), () => listeners.delete(l)),
      onExit: () => () => undefined,
      async dispose() {},
    };
  };
  return {
    id: "stub",
    displayName: "Stub Agent",
    hue: "sky",
    capabilities: { mcp: true } as AgentAdapter["capabilities"],
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ signedIn: true }),
    listModels: async () => [],
    terminalCommand: (o) => ({ file: "sh", args: [], cwd: o.cwd }),
    startSession: async () => session(),
  };
}

const noSinks = {
  event: () => undefined,
  status: () => undefined,
  updated: () => undefined,
  queue: () => undefined,
  turn: () => undefined,
  attention: () => undefined,
  raised: () => undefined,
};

const servers: WorkspaceMcpServer[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop()));

async function setup(opts: { confirm?: boolean; maxSpawned?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "latis-mcp-"));
  mkdirSync(join(dir, "cards"));
  const repo = join(dir, "shop");
  mkdirSync(repo);
  const store = new WorkspaceStore(openDb(join(dir, "latis.db")));
  const canvasId = store.ensureDefaultCanvas();
  const supervisor = new SessionSupervisor(store, new EventLog(store), new Map([["stub", replyAdapter()]]), noSinks);
  const cards = new Cards(store, join(dir, "cards"), { confirm: async () => true });
  const upserts: { nodes: CanvasNode[]; chats: ChatSummary[]; projects: Project[] }[] = [];
  const focused: FocusView[] = [];
  const ws = new WorkspaceService({
    store,
    canvasId,
    supervisor,
    agents: { available: async () => [{ id: "stub", displayName: "Stub Agent", signedIn: true }] },
    changes: {
      createWorktree: () => Promise.reject(new Error("no git here")),
      chatDiff: async () => [],
    },
    openProject: (folder, x, y) => {
      const p = store.findProjectByFolder(folder);
      if (p) return { project: p, node: store.getNode(p.frameNodeId)!, existed: true };
      return { ...store.createProject({ canvasId, folderPath: folder, x, y }), existed: false };
    },
    confirm: async () => opts.confirm ?? true,
    ui: { upsert: (p) => upserts.push(p), focus: (v) => focused.push(v), tidy: () => undefined },
    maxSpawned: () => opts.maxSpawned ?? 6,
    cards: {
      create: (input) => cards.create({ canvasId, ...input }),
      update: (id, patch) => cards.update(id, patch),
    },
  });
  const server = new WorkspaceMcpServer(ws);
  await server.start();
  servers.push(server);
  const conductor = store.createChatNode({
    canvasId,
    projectId: null,
    parentId: null,
    x: 0,
    y: 0,
    agentId: "stub",
    model: null,
    reasoning: null,
    permissionMode: "ask",
    cwd: dir,
    title: "Conductor",
    role: "conductor",
  }).chat;
  const client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.tokenFor(conductor.id)}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join("");
    return { text, isError: Boolean(r.isError), json: () => JSON.parse(text) as Record<string, unknown> };
  };
  return { store, server, conductor, call, repo, upserts, focused, client, cards };
}

describe("Workspace MCP server", () => {
  it("rejects callers without a known token, browsers and foreign hosts", async () => {
    const { server } = await setup();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    expect((await fetch(server.url, { method: "POST", headers, body })).status).toBe(401);
    expect((await fetch(server.url, { method: "POST", headers: { ...headers, authorization: "Bearer abc123" }, body })).status).toBe(401);
    const token = server.tokenFor("someone");
    const auth = { ...headers, authorization: `Bearer ${token}` };
    expect((await fetch(server.url, { method: "POST", headers: { ...auth, origin: "https://evil.example" }, body })).status).toBe(403);
    expect((await fetch(server.url, { method: "POST", headers: auth, body })).status).toBe(200);
  });

  it("lists the workspace tools", async () => {
    const { client } = await setup();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "append_note",
        "close_chat",
        "create_card",
        "create_note",
        "focus",
        "get_diff",
        "list_chats",
        "list_projects",
        "read_chat",
        "send_message",
        "spawn_chat",
        "tidy_canvas",
        "update_card",
        "wait_for_chats",
      ].sort(),
    );
  });

  it("S4: spawns three chats, waits for them, reads them and writes a summary note", async () => {
    const { call, repo, store, conductor, upserts } = await setup();
    const ids: string[] = [];
    for (const angle of ["security", "readability", "tests"]) {
      const r = await call("spawn_chat", { agent: "stub", cwd: repo, prompt: `Review auth for ${angle}`, title: `Auth: ${angle}` });
      expect(r.isError).toBe(false);
      ids.push(r.json().chat_id as string);
    }
    // One project frame holds all three; each chat inherits the caller's mode.
    const chats = ids.map((id) => store.getChat(id)!);
    expect(new Set(chats.map((c) => c.projectId)).size).toBe(1);
    expect(chats.every((c) => c.spawnedBy === conductor.id && c.permissionMode === "ask")).toBe(true);
    expect(chats.map((c) => c.title)).toEqual(["Auth: security", "Auth: readability", "Auth: tests"]);
    expect(upserts.some((u) => u.projects.length === 1 && u.chats.length === 1)).toBe(true);

    const waited = await call("wait_for_chats", { chat_ids: ids, timeout_s: 10 });
    const result = waited.json() as { timed_out: boolean; chats: { final_message: string; status: string }[] };
    expect(result.timed_out).toBe(false);
    expect(result.chats.map((c) => c.final_message)).toEqual([
      "Reviewed: Review auth for security",
      "Reviewed: Review auth for readability",
      "Reviewed: Review auth for tests",
    ]);

    const read = await call("read_chat", { chat_id: ids[0] });
    expect(read.text).toContain("## User\nReview auth for security");
    expect(read.text).toContain("## Assistant\nReviewed: Review auth for security");

    const note = await call("create_note", { title: "Where they agree", markdown: "- All three reviewed auth." });
    const noteId = note.json().note_id as string;
    await call("append_note", { note_id: noteId, markdown: "Done." });
    expect(store.getNode(noteId)!.data.text).toBe("# Where they agree\n\n- All three reviewed auth.\n\nDone.\n");
  });

  it("only accepts a stricter permission mode, and limits running chats per caller", async () => {
    const { call, repo, store } = await setup({ maxSpawned: 1 });
    const strict = await call("spawn_chat", { agent: "stub", cwd: repo, prompt: "a", permission_mode: "read-only" });
    expect(store.getChat(strict.json().chat_id as string)!.permissionMode).toBe("read-only");
    const over = await call("spawn_chat", { agent: "stub", cwd: repo, prompt: "b", permission_mode: "full-auto" });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("the limit is 1");
    await call("wait_for_chats", { chat_ids: [strict.json().chat_id], timeout_s: 10 });
    const looser = await call("spawn_chat", { agent: "stub", cwd: repo, prompt: "c", permission_mode: "full-auto" });
    expect(store.getChat(looser.json().chat_id as string)!.permissionMode).toBe("ask");
  });

  it("explains bad input instead of failing", async () => {
    const { call } = await setup();
    expect((await call("spawn_chat", { agent: "nope", cwd: "/", prompt: "x" })).text).toContain('No agent called "nope"');
    expect((await call("spawn_chat", { agent: "stub", cwd: "/definitely/not/here", prompt: "x" })).text).toContain("isn't a folder");
    expect((await call("read_chat", { chat_id: "missing" })).text).toContain("No chat with id missing");
  });

  it("closes only chats the caller started, after the user agrees", async () => {
    const yes = await setup({ confirm: true });
    const spawned = (await yes.call("spawn_chat", { agent: "stub", cwd: yes.repo, prompt: "x" })).json().chat_id as string;
    expect((await yes.call("close_chat", { chat_id: yes.conductor.id })).text).toContain("only close chats you started");
    expect((await yes.call("close_chat", { chat_id: spawned })).json()).toEqual({ closed: true });
    expect(yes.store.liveChats().some((c) => c.id === spawned)).toBe(false);

    const no = await setup({ confirm: false });
    const kept = (await no.call("spawn_chat", { agent: "stub", cwd: no.repo, prompt: "x" })).json().chat_id as string;
    expect((await no.call("close_chat", { chat_id: kept })).json()).toMatchObject({ closed: false });
  });

  it("creates and updates cards, served offline from their own origin with the bridge", async () => {
    const { call, cards, store } = await setup();
    const r = await call("create_card", { title: "Tracker", html: "<html><head><title>t</title></head><body>v1</body></html>" });
    const id = r.json().card_id as string;
    const res = cards.serve(`card://${id}/index.html`);
    expect(res.headers.get("content-security-policy")).toBe(cardCsp([]));
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'none'");
    const html = await res.text();
    expect(html).toContain(`<head><script src="card://${id}/__latis.js"></script><title>`);
    expect(html).toContain("v1");
    expect(await cards.serve(`card://${id}/__latis.js`).text()).toContain('Object.defineProperty(window, "latis"');
    // No escaping the folder, no serving the refresh script, no unknown cards.
    expect(cards.serve(`card://${id}/..%2F..%2Flatis.db`).status).toBe(404);
    expect(cards.serve(`card://nope/index.html`).status).toBe(404);
    await call("update_card", { card_id: id, html: "<p>v2</p>" });
    expect(await cards.serve(`card://${id}/`).text()).toContain("v2");
    const node = store.getNode(cards.row(id)!.nodeId)!;
    expect(node.type).toBe("card");
    expect(node.data.rev).toBe(2);
    expect((await call("update_card", { card_id: "nope", html: "x" })).isError).toBe(true);
  });

  it("opens focus views and keeps the Conductor undeletable", async () => {
    const { call, focused, store, conductor, repo } = await setup();
    const id = (await call("spawn_chat", { agent: "stub", cwd: repo, prompt: "x", title: "Site" })).json().chat_id as string;
    await call("focus", { node_ids: [id, conductor.id] });
    expect(focused[0]!.chatIds).toEqual([id, conductor.id]);
    expect(store.softDelete([conductor.nodeId])).toEqual([]);
  });
});
