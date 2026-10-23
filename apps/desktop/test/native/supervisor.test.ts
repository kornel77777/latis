import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentAdapter, AgentEvent, AgentSession, AttentionItem, SessionOptions } from "@latis/shared";
import { SessionSupervisor } from "../../src/main/agents/supervisor";
import { openDb } from "../../src/main/store/db";
import { EventLog } from "../../src/main/store/event-log";
import { WorkspaceStore } from "../../src/main/store/workspace";

interface Call {
  resume?: string;
  opts?: SessionOptions;
  sent: string[];
  steered: string[];
  emit: (e: AgentEvent) => void;
}

/** Adapter whose sessions play a fixed list of events per message; tests can also emit by hand. */
function stubAdapter(script: (resume: string | undefined, text: string) => AgentEvent[], calls: Call[], steerable = false): AgentAdapter {
  const session = (resume: string | undefined, opts: SessionOptions): AgentSession => {
    const listeners = new Set<(e: AgentEvent) => void>();
    const call: Call = { ...(resume && { resume }), opts, sent: [], steered: [], emit: (e) => listeners.forEach((l) => l(e)) };
    calls.push(call);
    return {
      id: "s",
      async send({ text }) {
        call.sent.push(text);
        queueMicrotask(() => script(resume, text).forEach(call.emit));
      },
      ...(steerable && {
        async steer(text: string) {
          call.steered.push(text);
        },
      }),
      async interrupt() {
        queueMicrotask(() => call.emit({ type: "turn.completed", status: "interrupted", durationMs: 1 }));
      },
      async respond() {},
      onEvent: (l) => (listeners.add(l), () => listeners.delete(l)),
      onExit: () => () => undefined,
      async dispose() {},
    };
  };
  return {
    id: "stub",
    displayName: "Stub",
    hue: "sky",
    capabilities: {} as AgentAdapter["capabilities"],
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ signedIn: true }),
    listModels: async () => [],
    terminalCommand: (o) => ({ file: "sh", args: [], cwd: o.cwd }),
    startSession: async (o) => session(undefined, o),
    resumeSession: async (id, o) => session(id, o),
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

function setup(script: Parameters<typeof stubAdapter>[0], steerable = false) {
  const dir = mkdtempSync(join(tmpdir(), "latis-sup-"));
  const store = new WorkspaceStore(openDb(join(dir, "latis.db")));
  const calls: Call[] = [];
  const updated: string[] = [];
  const inbox: { items: AttentionItem[]; raised: AttentionItem[] } = { items: [], raised: [] };
  const sup = new SessionSupervisor(store, new EventLog(store), new Map([["stub", stubAdapter(script, calls, steerable)]]), {
    ...noSinks,
    updated: (c) => updated.push(c.title),
    attention: (items) => (inbox.items = items),
    raised: (item) => inbox.raised.push(item),
  });
  const { chat } = store.createChatNode({
    canvasId: store.ensureDefaultCanvas(),
    projectId: null,
    parentId: null,
    x: 0,
    y: 0,
    agentId: "stub",
    model: "opus",
    reasoning: "high",
    permissionMode: "ask",
    cwd: dir,
    title: "New chat",
  });
  return { store, sup, chat, calls, updated, inbox };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const ok: AgentEvent[] = [
  { type: "session.started", nativeSessionId: "native-1", model: "m" },
  { type: "turn.completed", status: "ok", durationMs: 1 },
];

describe("SessionSupervisor", () => {
  it("passes chat options, stores the native session id, auto-titles, and resumes after restart", async () => {
    const { store, sup, chat, calls, updated } = setup(() => ok);
    await sup.send(chat.id, "Fix the login bug\nmore details");
    await tick();
    expect(calls[0]!.opts).toMatchObject({ model: "opus", reasoning: "high", permissionMode: "ask" });
    expect(store.nativeSessionId(chat.id)).toBe("native-1");
    expect(store.getChat(chat.id)).toMatchObject({ title: "Fix the login bug", resumable: true, status: "done" });
    expect(updated).toContain("Fix the login bug");

    await sup.restart(chat.id);
    await sup.send(chat.id, "again");
    await tick();
    expect(calls[1]!.resume).toBe("native-1");
  });

  it("keeps a user-set title", async () => {
    const { store, sup, chat } = setup(() => ok);
    await sup.setOptions(chat.id, { title: "Mine" });
    await sup.send(chat.id, "something else");
    await tick();
    expect(store.getChat(chat.id)?.title).toBe("Mine");
  });

  it("forgets a native session id that can't be resumed", async () => {
    const { store, sup, chat } = setup((resume) =>
      resume
        ? [
            { type: "error", message: "No conversation found", recoverable: true },
            { type: "turn.completed", status: "error", durationMs: 1 },
          ]
        : ok,
    );
    store.updateChat(chat.id, { nativeSessionId: "gone" });
    await sup.send(chat.id, "hello");
    await tick();
    expect(store.nativeSessionId(chat.id)).toBeNull();
    const errors = store.transcript(chat.id).events.filter((e) => e.event.type === "error");
    expect(errors.at(-1)?.event).toMatchObject({ message: expect.stringContaining("Couldn't resume") });
  });

  it("records a start failure in the chat instead of throwing", async () => {
    const { store, sup, chat } = setup(() => ok);
    store.updateChat(chat.id, {});
    const broken = new SessionSupervisor(store, new EventLog(store), new Map(), noSinks);
    const turn = await broken.send(chat.id, "hi");
    expect(turn.status).toBe("error");
    expect(store.getChat(chat.id)?.status).toBe("error");
    void sup;
  });

  it("steers a running turn when the agent supports it and logs the steer", async () => {
    const started: AgentEvent[] = [{ type: "session.started", model: "m" }];
    const { store, sup, chat, calls } = setup(() => started, true);
    await sup.send(chat.id, "start");
    await tick();
    const res = await sup.steer(chat.id, "actually do B");
    expect(res.delivered).toBe("steered");
    expect(calls[0]!.steered).toEqual(["actually do B"]);
    store.db.$client.pragma("wal_checkpoint");
    sup["log"].flush();
    expect(store.transcript(chat.id).events.map((e) => e.event)).toContainEqual({ type: "user.steered", text: "actually do B" });
  });

  it("queues mid-turn messages for agents that can't steer and sends them after the turn", async () => {
    const { sup, chat, calls } = setup((_r, text) => (text === "start" ? [{ type: "session.started", model: "m" }] : ok));
    await sup.send(chat.id, "start");
    await tick();
    const res = await sup.steer(chat.id, "next thing");
    expect(res).toMatchObject({ delivered: "queued", queue: [{ text: "next thing" }] });
    const edited = sup.editQueued(chat.id, res.queue[0]!.id, "next thing, edited");
    expect(edited[0]!.text).toBe("next thing, edited");
    calls[0]!.emit({ type: "turn.completed", status: "ok", durationMs: 1 });
    await tick();
    expect(calls[0]!.sent).toEqual(["start", "next thing, edited"]);
    expect(sup.queueOf(chat.id)).toEqual([]);
  });

  it("keeps the queue when the user stops a turn, and Send now interrupts then sends", async () => {
    const { sup, chat, calls } = setup((_r, text) => (text === "start" ? [{ type: "session.started", model: "m" }] : ok));
    await sup.send(chat.id, "start");
    await tick();
    await sup.steer(chat.id, "later");
    await sup.steer(chat.id, "urgent");
    await sup.interrupt(chat.id);
    await tick();
    expect(calls[0]!.sent).toEqual(["start"]);
    expect(sup.queueOf(chat.id)).toHaveLength(2);
    await sup.send(chat.id, "start");
    await tick();
    await sup.sendNow(chat.id, sup.queueOf(chat.id).find((q) => q.text === "urgent")!.id);
    await tick();
    // "urgent" goes first; once it finishes cleanly the rest of the queue follows.
    expect(calls[0]!.sent).toEqual(["start", "start", "urgent", "later"]);
    expect(sup.queueOf(chat.id)).toEqual([]);
  });

  it("raises Inbox items for requests and finished turns, and resolves them", async () => {
    const { sup, chat, calls, inbox } = setup((_r, text) =>
      text === "ask"
        ? [
            { type: "session.started", model: "m" },
            { type: "permission.requested", id: "req-1", kind: "exec", summary: "Run a command", command: "npm install" },
          ]
        : ok,
    );
    await sup.send(chat.id, "ask");
    await tick();
    expect(inbox.items).toEqual([
      expect.objectContaining({ kind: "permission", refId: "req-1", summary: "Run a command", detail: "npm install" }),
    ]);
    await sup.respond(chat.id, "req-1", { kind: "permission", decision: "allow-once" });
    expect(inbox.items).toEqual([]);
    calls[0]!.emit({ type: "message.completed", text: "Installed 3 packages.\nDetails…" });
    calls[0]!.emit({ type: "turn.completed", status: "ok", durationMs: 1 });
    expect(inbox.items).toEqual([expect.objectContaining({ kind: "finished", detail: "Installed 3 packages." })]);
    expect(inbox.raised.map((i) => i.kind)).toEqual(["permission", "finished"]);
    sup.seen(chat.id);
    expect(inbox.items).toEqual([]);
  });

  it("clears a request item when the agent moves on without Latis answering it", async () => {
    const { sup, chat, calls, inbox } = setup(() => [
      { type: "session.started", model: "m" },
      { type: "permission.requested", id: "req-2", kind: "edit", summary: "Edit a.txt" },
    ]);
    await sup.send(chat.id, "go");
    await tick();
    expect(inbox.items).toHaveLength(1);
    calls[0]!.emit({ type: "tool.completed", id: "t", status: "ok" });
    expect(inbox.items).toEqual([]);
  });
});
