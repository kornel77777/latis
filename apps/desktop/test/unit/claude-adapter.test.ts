import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentEvent, buildTranscript, type StoredEvent, type Turn } from "@latis/shared";
import { ClaudeCodeAdapter, type QueryFn } from "../../src/main/agents/adapters/claude-code";
import { ClaudeMapper, toolKind } from "../../src/main/agents/adapters/claude-code/mapper";

type Line =
  { kind: "message"; data: SDKMessage } | { kind: "can_use_tool"; data: Record<string, unknown> } | { kind: string; data: unknown };
const CWD = "/repo";

function fixture(name: string): Line[] {
  const raw = readFileSync(new URL(`../../../../fixtures/claude-code/${name}.jsonl`, import.meta.url), "utf8");
  // Recordings scrub the sandbox path to <cwd>; map it to a stable fake cwd.
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l.replaceAll("<cwd>", CWD)) as Line);
}

const messages = (lines: Line[]) =>
  lines.filter((l): l is { kind: "message"; data: SDKMessage } => l.kind === "message").map((l) => l.data);

function mapAll(name: string): AgentEvent[] {
  const m = new ClaudeMapper(CWD);
  return messages(fixture(name)).flatMap((msg) => m.map(msg));
}

describe("ClaudeMapper", () => {
  it.each(["allow-write-bash", "deny-write", "two-turns-edit", "ask-question", "plan-mode"])("maps %s to schema-valid events", (name) => {
    const events = mapAll(name);
    for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(events[0]).toMatchObject({ type: "session.started", model: expect.stringContaining("claude-") });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "ok" });
  });

  it("streams text and completes it with the full message", () => {
    const events = mapAll("allow-write-bash");
    const streamed = events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    const completed = events.filter((e) => e.type === "message.completed").at(-1);
    expect(streamed.length).toBeGreaterThan(0);
    expect(completed).toMatchObject({ text: streamed });
  });

  it("maps tool calls with kinds and relative paths", () => {
    const events = mapAll("two-turns-edit");
    const started = events.filter((e) => e.type === "tool.started");
    expect(started.map((e) => e.type === "tool.started" && [e.name, e.kind, e.paths])).toEqual([
      ["Write", "edit", ["a.txt"]],
      ["Read", "read", ["a.txt"]],
      ["Edit", "edit", ["a.txt"]],
    ]);
  });

  it("emits file changes with diff hunks", () => {
    const changes = mapAll("two-turns-edit").filter((e) => e.type === "file.changed");
    expect(changes[0]).toMatchObject({ path: "a.txt", change: "created", additions: 1, deletions: 0 });
    expect(changes[1]).toMatchObject({ path: "a.txt", change: "modified", additions: 1, deletions: 1 });
    expect(changes[1]!.type === "file.changed" && changes[1]!.hunks?.[0]?.lines).toEqual(expect.arrayContaining(["-one", "+two"]));
  });

  it("reports per-turn cost, not the cumulative session total", () => {
    const usage = mapAll("two-turns-edit").filter((e) => e.type === "usage");
    expect(usage).toHaveLength(2);
    const [a, b] = usage.map((u) => (u.type === "usage" ? u.costUsd! : 0));
    expect(a).toBeCloseTo(0.00242652, 6);
    expect(b).toBeCloseTo(0.00326801 - 0.00242652, 6);
  });

  it("marks a denied tool as denied", () => {
    const m = new ClaudeMapper(CWD);
    const msgs = messages(fixture("deny-write"));
    const toolId = msgs.flatMap((x) => (x.type === "assistant" ? x.message.content : [])).find((b) => b.type === "tool_use")!;
    m.markDenied((toolId as { id: string }).id);
    const done = msgs.flatMap((x) => m.map(x)).find((e) => e.type === "tool.completed");
    expect(done).toMatchObject({ status: "denied" });
  });

  it("turns AskUserQuestion and ExitPlanMode into question and plan events", () => {
    const m = new ClaudeMapper(CWD);
    const ask = fixture("ask-question").find((l) => l.kind === "can_use_tool")!.data as {
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
    };
    expect(m.requestEvent(ask.toolName, ask.input, { toolUseID: ask.toolUseID })).toMatchObject({
      type: "question.asked",
      question: "Which greeting should I use?",
      questions: [{ header: "Greeting", options: [{ label: "Hello" }, { label: "Hi" }], multiSelect: false }],
    });
    const plan = fixture("plan-mode").find((l) => l.kind === "can_use_tool")!.data as {
      toolName: string;
      input: Record<string, unknown>;
      toolUseID: string;
    };
    expect(m.requestEvent(plan.toolName, plan.input, { toolUseID: plan.toolUseID })).toMatchObject({
      type: "plan.proposed",
      markdown: expect.stringContaining("CONTRIBUTING.md"),
    });
  });

  it("maps an interrupted result to an interrupted turn, and other failures to errors", () => {
    const result = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 50,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 2 },
      errors: ["No conversation found with session ID: x"],
    } as unknown as SDKMessage;
    const m = new ClaudeMapper(CWD);
    expect(m.map(result).map((e) => e.type)).toEqual(["usage", "error", "turn.completed"]);
    m.markInterrupting();
    expect(m.map(result).at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" });
  });

  it("classifies tools", () => {
    expect(["Read", "Write", "Bash", "Grep", "WebFetch", "Agent", "mcp__x__y", "TodoWrite"].map(toolKind)).toEqual([
      "read",
      "edit",
      "exec",
      "search",
      "web",
      "subagent",
      "mcp",
      "other",
    ]);
  });
});

/** A stand-in for the SDK's query(): replays a recording, pausing at each turn and permission prompt. */
function replayQuery(name: string, seen: { options?: Options }): QueryFn {
  return (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    seen.options = options;
    const lines = fixture(name);
    const input = prompt[Symbol.asyncIterator]();
    async function* run(): AsyncGenerator<SDKMessage> {
      let awaitingTurn = true;
      for (const l of lines) {
        if (awaitingTurn && l.kind === "message") {
          if ((await input.next()).done) return;
          awaitingTurn = false;
        }
        if (l.kind === "can_use_tool") {
          const d = l.data as { toolName: string; input: Record<string, unknown>; toolUseID: string };
          const ctx = { signal: new AbortController().signal, toolUseID: d.toolUseID, suggestions: [] };
          await options.canUseTool!(d.toolName, d.input, ctx as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2]);
        } else if (l.kind === "message") {
          yield l.data as SDKMessage;
          if ((l.data as SDKMessage).type === "result") awaitingTurn = true;
        }
      }
    }
    const gen = run();
    return Object.assign(gen, {
      interrupt: async () => undefined,
      close: () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
    }) as unknown as Query;
  }) as unknown as QueryFn;
}

async function drive(
  name: string,
  onRequest: (e: AgentEvent, respond: (r: Parameters<import("@latis/shared").AgentSession["respond"]>[1]) => void) => void,
  turns = ["go"],
) {
  const seen: { options?: Options } = {};
  const adapter = new ClaudeCodeAdapter({ queryFn: replayQuery(name, seen), executable: "/usr/bin/claude" });
  const session = await adapter.startSession({ cwd: CWD, permissionMode: "ask", alwaysAsk: [], model: "haiku", reasoning: "low" });
  const events: StoredEvent[] = [];
  const done = new Promise<void>((resolve) => {
    let completed = 0;
    session.onEvent((e) => {
      events.push({ chatId: "c", seq: events.length, ts: 0, turnId: `t${completed}`, event: e });
      if (e.type === "permission.requested" || e.type === "question.asked" || e.type === "plan.proposed") {
        onRequest(e, (r) => void session.respond(e.id, r));
      }
      if (e.type === "turn.completed" && ++completed === turns.length) resolve();
      if (e.type === "turn.completed" && completed < turns.length) void session.send({ text: turns[completed]! });
    });
  });
  await session.send({ text: turns[0]! });
  await done;
  await session.dispose();
  return { events, options: seen.options!, session };
}

describe("ClaudeCodeAdapter session (replayed)", () => {
  it("passes chat options to the SDK", async () => {
    const { options } = await drive("allow-write-bash", (_e, r) => r({ kind: "permission", decision: "allow-once" }));
    expect(options).toMatchObject({
      cwd: CWD,
      model: "haiku",
      effort: "low",
      permissionMode: "default",
      includePartialMessages: true,
      pathToClaudeCodeExecutable: "/usr/bin/claude",
      thinking: { type: "adaptive", display: "summarized" },
    });
  });

  it("round-trips a permission and records the native session id", async () => {
    const asked: AgentEvent[] = [];
    const { events, session } = await drive("allow-write-bash", (e, r) => {
      asked.push(e);
      r({ kind: "permission", decision: "allow-once" });
    });
    expect(asked[0]).toMatchObject({ type: "permission.requested", kind: "exec", command: expect.stringContaining("ls") });
    expect(session.nativeSessionId).toBe("76c001cc-09b9-4434-8bbd-5986cf3602db");
    expect(events.find((e) => e.event.type === "tool.completed")?.event).toMatchObject({ status: "ok" });
  });

  it("marks denied tools as denied in the transcript", async () => {
    const { events } = await drive("deny-write", (_e, r) => r({ kind: "permission", decision: "deny" }));
    const turns: Turn[] = [{ id: "t0", chatId: "c", seq: 0, userText: "go", startedAt: 0, endedAt: 1, status: "ok" }];
    const step = buildTranscript(turns, events).find((i) => i.kind === "step");
    expect(step).toMatchObject({ name: "Write", status: "denied" });
  });

  it("answers questions and approves plans", async () => {
    const q = await drive("ask-question", (_e, r) => r({ kind: "answer", answers: { "Which greeting should I use?": "Hello" } }));
    expect(q.events.some((e) => e.event.type === "question.asked")).toBe(true);
    const p = await drive("plan-mode", (_e, r) => r({ kind: "plan", approve: true }));
    expect(p.events.some((e) => e.event.type === "plan.proposed")).toBe(true);
  });

  it("runs two turns in one session and attaches diffs to their steps", async () => {
    const { events } = await drive("two-turns-edit", (_e, r) => r({ kind: "permission", decision: "allow-chat" }), ["create", "edit"]);
    const turns: Turn[] = ["t0", "t1"].map((id, seq) => ({ id, chatId: "c", seq, userText: id, startedAt: 0, endedAt: 1, status: "ok" }));
    const steps = buildTranscript(turns, events).filter((i) => i.kind === "step");
    const edit = steps.find((s) => s.kind === "step" && s.name === "Edit");
    expect(edit).toMatchObject({ files: [{ path: "a.txt", additions: 1, deletions: 1 }] });
  });

  it("reports not-installed instead of starting", async () => {
    const adapter = new ClaudeCodeAdapter({ queryFn: replayQuery("deny-write", {}), executable: null });
    expect(await adapter.detect()).toEqual({ installed: false });
    await expect(adapter.startSession({ cwd: CWD, permissionMode: "ask", alwaysAsk: [] })).rejects.toThrow(/isn't installed/);
  });
});
