import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate, migrations, openDb } from "../../src/main/store/db";
import { EventLog } from "../../src/main/store/event-log";
import { WorkspaceStore } from "../../src/main/store/workspace";

const file = () => join(mkdtempSync(join(tmpdir(), "latis-store-")), "latis.db");

describe("migrations", () => {
  it("apply once and are idempotent", () => {
    expect(migrations.length).toBeGreaterThan(0);
    const db = new Database(file());
    migrate(db);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(migrations.length);
    const tables = db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["canvases", "nodes", "chats", "turns", "events", "settings"]));
  });
});

describe("WorkspaceStore", () => {
  it("persists canvas, chats, geometry, viewport and settings across reopen", () => {
    const path = file();
    const a = new WorkspaceStore(openDb(path));
    const canvasId = a.ensureDefaultCanvas();
    const { node, chat } = a.createChatNode({
      canvasId,
      x: 10,
      y: 20,
      projectId: null,
      parentId: null,
      agentId: "fake",
      model: null,
      reasoning: null,
      permissionMode: "auto-edit",
      cwd: "/tmp/x",
      title: "T",
    });
    a.saveNodeGeometry([{ id: node.id, x: 100, y: 200, w: 500, h: 600, z: 1 }]);
    a.saveViewport(canvasId, { x: 5, y: 6, zoom: 0.5 });
    a.updateChat(chat.id, { status: "done" });
    a.setSetting("theme", "light");
    const turn = a.createTurn(chat.id, "hello");
    a.endTurn(turn.id, "ok");
    a.db.$client.close();

    const b = new WorkspaceStore(openDb(path));
    const state = b.loadCanvas(b.ensureDefaultCanvas());
    expect(state.viewport).toEqual({ x: 5, y: 6, zoom: 0.5 });
    expect(state.nodes[0]).toMatchObject({ id: node.id, x: 100, y: 200, w: 500, h: 600, data: { chatId: chat.id } });
    expect(state.chats[0]).toMatchObject({ id: chat.id, status: "done" });
    expect(b.getSetting("theme")).toBe("light");
    expect(b.transcript(chat.id).turns[0]).toMatchObject({ userText: "hello", status: "ok" });
    expect(b.createTurn(chat.id, "again").seq).toBe(1);
  });
});

describe("EventLog", () => {
  it("batches writes, flushes on turn end, and continues seqs after reopen", () => {
    vi.useFakeTimers();
    const path = file();
    const store = new WorkspaceStore(openDb(path));
    const { chat } = store.createChatNode({
      canvasId: store.ensureDefaultCanvas(),
      x: 0,
      y: 0,
      projectId: null,
      parentId: null,
      agentId: "fake",
      model: null,
      reasoning: null,
      permissionMode: "auto-edit",
      cwd: "/tmp",
      title: "T",
    });
    const log = new EventLog(store);

    log.append(chat.id, null, { type: "message.delta", text: "a" });
    expect(store.transcript(chat.id).events).toHaveLength(0);
    vi.advanceTimersByTime(260);
    expect(store.transcript(chat.id).events).toHaveLength(1);

    log.append(chat.id, null, { type: "message.delta", text: "b" });
    log.append(chat.id, null, { type: "turn.completed", status: "ok", durationMs: 1 });
    expect(store.transcript(chat.id).events.map((e) => e.seq)).toEqual([0, 1, 2]);

    const log2 = new EventLog(store);
    expect(log2.append(chat.id, null, { type: "usage" }).seq).toBe(3);
    vi.useRealTimers();
  });

  it("soft-deletes a project frame with its contents, lists it for restore, and restores it", () => {
    const store = new WorkspaceStore(openDb(file()));
    const canvasId = store.ensureDefaultCanvas();
    const { project, node: frame } = store.createProject({ canvasId, folderPath: "/tmp/latis-x", x: 0, y: 0 });
    const { node: chatNode } = store.createChatNode({
      canvasId,
      projectId: project.id,
      parentId: frame.id,
      x: 0,
      y: 0,
      agentId: "fake",
      model: null,
      reasoning: null,
      permissionMode: "ask",
      cwd: "/tmp/latis-x",
      title: "Pricing",
    });
    const note = store.createNote({ canvasId, projectId: null, parentId: null, x: 900, y: 0, text: "# Ideas\nmore" });

    const deleted = store.softDelete([frame.id]);
    expect(deleted.sort()).toEqual([frame.id, chatNode.id].sort());
    const after = store.loadCanvas(canvasId);
    expect(after.nodes.map((n) => n.id)).toEqual([note.id]);
    expect(after.projects).toEqual([]);
    expect(store.deletedItems(canvasId)).toEqual([
      expect.objectContaining({ type: "frame", title: "latis-x", nodeIds: expect.arrayContaining([frame.id, chatNode.id]) }),
    ]);

    store.restore(deleted);
    const back = store.loadCanvas(canvasId);
    expect(back.nodes).toHaveLength(3);
    expect(back.projects.map((p) => p.id)).toEqual([project.id]);
    expect(back.chats[0]?.title).toBe("Pricing");

    store.softDelete([note.id]);
    expect(store.deletedItems(canvasId)[0]).toMatchObject({ type: "note", title: "Ideas" });
  });
});
