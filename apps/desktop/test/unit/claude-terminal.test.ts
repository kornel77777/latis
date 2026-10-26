import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentEvent, type AgentSession, type SessionOptions } from "@latis/shared";
import { ClaudeTerminalAdapter } from "../../src/main/agents/adapters/claude-code/terminal";
import type { HookEndpoint, HookHandler } from "../../src/main/mcp/server";
import type { PtyManager } from "../../src/main/terminal/pty-manager";

type PtyEvent = { data?: string; input?: string; exit?: number | null };

function fakePtys() {
  const spawned: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  const written: string[] = [];
  let listener: ((e: PtyEvent) => void) | null = null;
  let killed = false;
  const ptys = {
    create: async (spec: { file: string; args: string[]; env: Record<string, string | undefined> }) => {
      spawned.push(spec);
      return { id: "pty-1" };
    },
    subscribe: (_id: string, fn: (e: PtyEvent) => void) => {
      listener = fn;
      return () => (listener = null);
    },
    write: (_id: string, data: string) => written.push(data),
    kill: () => (killed = true),
  } as unknown as PtyManager;
  return { ptys, spawned, written, push: (e: PtyEvent) => listener?.(e), killed: () => killed };
}

function fakeEndpoint() {
  let handler: HookHandler | null = null;
  const endpoint: HookEndpoint = {
    hookUrl: "http://127.0.0.1:4321/hooks",
    hookTokenFor: (chatId) => `token-${chatId}`,
    onHook: (_chatId, h) => {
      handler = h;
      return () => (handler = null);
    },
  };
  return { endpoint, hook: (input: Record<string, unknown>) => handler!(input), registered: () => handler !== null };
}

async function open(opts: Partial<SessionOptions> = {}, resumeId?: string) {
  const runDir = mkdtempSync(join(tmpdir(), "latis-claude-term-"));
  const p = fakePtys();
  const e = fakeEndpoint();
  const adapter = new ClaudeTerminalAdapter(p.ptys, { endpoint: async () => e.endpoint, runDir, executable: "/usr/bin/claude" });
  const base: SessionOptions = { cwd: "/repo", chatId: "c1", permissionMode: "auto-edit", alwaysAsk: ["git push", "rm -rf"], ...opts };
  const session = resumeId ? await adapter.resumeSession(resumeId, base) : await adapter.startSession(base);
  const events: AgentEvent[] = [];
  session.onEvent((ev) => events.push(ev));
  await new Promise((r) => setTimeout(r, 0));
  return { session, events, runDir, ...p, ...e };
}

const respondTo = (session: AgentSession, events: AgentEvent[], decision: "allow-once" | "allow-chat" | "deny") => {
  const req = events.findLast((x) => x.type === "permission.requested");
  if (req?.type !== "permission.requested") throw new Error("no request");
  void session.respond(req.id, { kind: "permission", decision });
  return req;
};

afterEach(() => vi.useRealTimers());

describe("ClaudeTerminalAdapter", () => {
  it("starts claude with a session id and a private settings file whose HTTP hooks report to Latis", async () => {
    const { spawned, events, runDir } = await open();
    const args = spawned[0]!.args;
    expect(args[0]).toBe("--session-id");
    const sessionId = args[1]!;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[0]).toEqual({ type: "session.started", nativeSessionId: sessionId, model: "Claude Code" });
    const file = args[args.indexOf("--settings") + 1]!;
    expect(file.startsWith(runDir)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(readFileSync(file, "utf8")) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      "Notification",
      "PermissionRequest",
      "PostToolUse",
      "PreToolUse",
      "Stop",
      "UserPromptSubmit",
    ]);
    expect(settings.hooks.PreToolUse![0]!.hooks[0]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:4321/hooks",
      headers: { Authorization: "Bearer token-c1" },
    });
  });

  it("resumes by id, passes workspace tools and instructions, and removes its files when disposed", async () => {
    const { session, spawned, registered } = await open(
      {
        mcpServers: [{ name: "latis", transport: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } }],
        systemPromptAppend: "Use the latis tools.",
      },
      "11111111-2222-3333-4444-555555555555",
    );
    const args = spawned[0]!.args;
    expect(args.slice(0, 2)).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
    const mcpFile = args[args.indexOf("--mcp-config") + 1]!;
    expect(JSON.parse(readFileSync(mcpFile, "utf8"))).toEqual({
      mcpServers: { latis: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } } },
    });
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Use the latis tools.");
    await session.dispose();
    expect(existsSync(mcpFile)).toBe(false);
    expect(existsSync(args[args.indexOf("--settings") + 1]!)).toBe(false);
    expect(registered()).toBe(false);
  });

  it("records a typed prompt as a turn before Claude sees it, and ends it on Stop", async () => {
    const order: string[] = [];
    const onUserTurn = vi.fn(async (text: string) => {
      order.push(`turn:${text}`);
    });
    const { hook, events } = await open({ onUserTurn });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" });
    order.push("answered");
    expect(order).toEqual(["turn:fix the bug", "answered"]);
    expect(events.at(-1)).toEqual({ type: "agent.status", status: "working" });
    await hook({ hook_event_name: "Stop", last_assistant_message: "Fixed it." });
    expect(events.slice(-2)).toEqual([
      { type: "message.completed", text: "Fixed it." },
      expect.objectContaining({ type: "turn.completed", status: "ok" }),
    ]);
    for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
  });

  it("doesn't start a second turn for text Latis typed", async () => {
    const onUserTurn = vi.fn(async () => undefined);
    const { session, hook, written } = await open({ onUserTurn });
    await session.send({ text: "from the queue" });
    expect(written[0]).toBe("from the queue");
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "from the queue" });
    expect(onUserTurn).not.toHaveBeenCalled();
  });

  it("holds always-ask commands for Latis and lets the rest through", async () => {
    const { session, hook, events } = await open();
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t1" })).toEqual({});
    const held = hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      tool_use_id: "t2",
    });
    await Promise.resolve();
    const req = respondTo(session, events, "deny");
    expect(req).toMatchObject({ id: "t2", kind: "exec", command: "git push origin main", alwaysAsk: "git push" });
    expect(await held).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "The user denied this in Latis.",
      },
    });
  });

  it("answers Claude Code's approvals from Latis, keeping 'always' in the session", async () => {
    const { session, hook, events } = await open();
    const held = hook({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: [
        { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" },
      ],
    });
    await Promise.resolve();
    const req = respondTo(session, events, "allow-chat");
    expect(req).toMatchObject({ kind: "exec", command: "npm test" });
    expect(await held).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedPermissions: [
            { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" },
          ],
        },
      },
    });
    // The answer is followed by an event, so the request shows as answered.
    expect(events.at(-1)).toEqual({ type: "agent.status", status: "working" });
  });

  it("lets an approval answered in the terminal go", async () => {
    const { hook } = await open();
    const held = hook({ hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "/repo/a.txt" } });
    await hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "/repo/a.txt" } });
    expect(await held).toEqual({});
  });

  it("treats Esc mid-turn with nothing after it as an interrupt", async () => {
    const { hook, push, events } = await open();
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "long task" });
    vi.useFakeTimers();
    push({ input: "\x1b" });
    vi.advanceTimersByTime(3000);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" });
  });

  it("uses a new always-ask list from the next tool call", async () => {
    const { session, hook } = await open();
    session.setAlwaysAsk!([]);
    expect(
      await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" }, tool_use_id: "t3" }),
    ).toEqual({});
  });
});
