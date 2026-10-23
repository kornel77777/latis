import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentEvent, type AgentSession, type PermissionMode } from "@latis/shared";
import { CodexAdapter } from "../../src/main/agents/adapters/codex";
import { CodexMapper, unwrapCommand } from "../../src/main/agents/adapters/codex/mapper";
import { ReplayLibrary, replayTransport } from "../../src/main/agents/rpc/replay";

const CWD = "/repo";
const DIR = fileURLToPath(new URL("../../../../fixtures/codex", import.meta.url));
type Line = { dir: string; msg: { id?: number; method?: string; params?: Record<string, unknown> } };

function fixture(name: string): Line[] {
  return readFileSync(`${DIR}/${name}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l.replaceAll("<cwd>", CWD)) as Line);
}

function mapAll(name: string): AgentEvent[] {
  const m = new CodexMapper(CWD);
  return fixture(name).flatMap(({ dir, msg }) => {
    if (dir !== "in" || !msg.method) return [];
    if (msg.id !== undefined) return [m.request(msg.method, msg.params ?? {})?.event].filter((e): e is AgentEvent => Boolean(e));
    return m.notification(msg.method, msg.params ?? {});
  });
}

describe("unwrapCommand", () => {
  it("strips Codex's login-shell wrapper", () => {
    expect(unwrapCommand(`/bin/zsh -lc 'pwd && ls -la'`)).toBe("pwd && ls -la");
    expect(unwrapCommand(`/bin/zsh -lc "printf '%s\\\\n' 'hi' > a.txt"`)).toBe(`printf '%s\\n' 'hi' > a.txt`);
    expect(unwrapCommand("ls")).toBe("ls");
  });
});

describe("CodexMapper", () => {
  it.each(["write-and-run", "edit-file", "deny-write", "steer", "interrupt", "resume"])("maps %s to schema-valid events", (name) => {
    const events = mapAll(name);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("streams agent messages and completes them", () => {
    const events = mapAll("edit-file");
    const final = events.filter((e) => e.type === "message.completed").at(-1);
    expect(final).toMatchObject({ text: expect.stringContaining("README.md") });
    expect(events.some((e) => e.type === "message.delta")).toBe(true);
  });

  it("maps a patch to a file change with hunks, relative to the chat folder", () => {
    const events = mapAll("edit-file");
    expect(events.find((e) => e.type === "tool.started" && e.kind === "edit")).toMatchObject({ name: "Edit", paths: ["README.md"] });
    const change = events.find((e) => e.type === "file.changed");
    expect(change).toMatchObject({ path: "README.md", change: "modified", additions: 2, deletions: 1 });
    expect(change?.type === "file.changed" && change.hunks?.[0]?.lines).toEqual([
      "-# Recording sandbox",
      "+# Edited by Codex",
      "+Second line.",
    ]);
  });

  it("classifies commands by Codex's own parse and unwraps them", () => {
    const events = mapAll("edit-file");
    expect(events.find((e) => e.type === "tool.started" && e.name === "Shell")).toMatchObject({
      kind: "read",
      input: { command: "cat README.md" },
      paths: ["README.md"],
    });
  });

  it("asks before commands and patches, and marks declines as denied", () => {
    const events = mapAll("deny-write");
    expect(events.find((e) => e.type === "permission.requested")).toMatchObject({ kind: "exec", command: "pwd && ls -la" });
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ status: "denied" });
  });

  it("closes running steps when a turn is interrupted", () => {
    const events = mapAll("interrupt");
    expect(events.filter((e) => e.type === "tool.completed")).toEqual([expect.objectContaining({ status: "error", output: "Stopped" })]);
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" });
  });

  it("reports per-turn token usage", () => {
    const usage = mapAll("write-and-run").filter((e) => e.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) });
  });
});

function adapter() {
  const lib = new ReplayLibrary(DIR, { fallback: "write-and-run", turnMethod: "turn/start", paceMs: 0 });
  return new CodexAdapter({ transport: (cwd) => replayTransport(lib, cwd), executable: "/replay/codex" });
}

function collect(session: AgentSession) {
  const events: AgentEvent[] = [];
  session.onEvent((e) => events.push(e));
  const waitFor = async (pred: (e: AgentEvent) => boolean, ms = 3000): Promise<AgentEvent> => {
    const start = Date.now();
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      if (Date.now() - start > ms) throw new Error(`timed out; got ${events.map((e) => e.type).join(", ")}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { events, waitFor };
}

const opts = (permissionMode: PermissionMode) => ({ cwd: CWD, permissionMode, alwaysAsk: [] });

describe("CodexAdapter (replayed app-server)", () => {
  it("lists models with a default entry and reports the account without spending tokens", async () => {
    const a = adapter();
    const models = await a.listModels();
    expect(models[0]).toMatchObject({ id: "default", label: expect.stringContaining("Default") });
    expect(models.find((m) => m.id === "gpt-6-luna")?.reasoningLevels).toContain("low");
    expect(await a.authStatus()).toMatchObject({ signedIn: true, method: "subscription" });
  });

  it("round-trips a command approval", async () => {
    const s = await adapter().startSession(opts("auto-edit"));
    const { events, waitFor } = collect(s);
    expect(s.nativeSessionId).toBe("<id2>");
    await s.send({ text: "make hello.txt" });
    const req = await waitFor((e) => e.type === "permission.requested");
    expect(req).toMatchObject({ kind: "exec", command: expect.stringContaining("wc -l hello.txt") });
    await s.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "allow-once" });
    await waitFor((e) => e.type === "turn.completed");
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ status: "ok" });
    await s.dispose();
  });

  it("auto-accepts reads and in-folder patches in Auto-edit", async () => {
    const s = await adapter().startSession(opts("auto-edit"));
    const { events, waitFor } = collect(s);
    await s.send({ text: "please /edit-file" });
    await waitFor((e) => e.type === "turn.completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(0);
    expect(events.find((e) => e.type === "file.changed")).toMatchObject({ path: "README.md" });
    await s.dispose();
  });

  it("asks before patches in Ask mode", async () => {
    const s = await adapter().startSession(opts("ask"));
    const { waitFor } = collect(s);
    await s.send({ text: "please /edit-file" });
    const req = await waitFor((e) => e.type === "permission.requested");
    expect(req).toMatchObject({ kind: "edit", summary: "Edit README.md", paths: ["README.md"] });
    await s.dispose();
  });

  it("denies with decline", async () => {
    const s = await adapter().startSession(opts("ask"));
    const { waitFor } = collect(s);
    await s.send({ text: "/deny-write" });
    const req = await waitFor((e) => e.type === "permission.requested");
    await s.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "deny" });
    expect(await waitFor((e) => e.type === "tool.completed")).toMatchObject({ status: "denied" });
    await s.dispose();
  });

  it("steers a running turn", async () => {
    const s = await adapter().startSession(opts("auto-edit"));
    const { waitFor } = collect(s);
    await s.send({ text: "fruits please /steer" });
    await waitFor((e) => e.type === "message.completed");
    await s.steer!("Actually use vegetables instead of fruits, and name the file vegetables.txt.");
    const req = await waitFor((e) => e.type === "permission.requested");
    expect(req).toMatchObject({ command: expect.stringContaining("vegetables.txt") });
    await s.dispose();
  });

  it("interrupts a running turn", async () => {
    const s = await adapter().startSession(opts("auto-edit"));
    const { waitFor } = collect(s);
    await s.send({ text: "/interrupt" });
    const req = await waitFor((e) => e.type === "permission.requested");
    await s.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "allow-once" });
    await waitFor((e) => e.type === "tool.started");
    await s.interrupt();
    expect(await waitFor((e) => e.type === "turn.completed")).toMatchObject({ status: "interrupted" });
    await s.dispose();
  });

  it("resumes a thread in a new process", async () => {
    const s = await adapter().resumeSession!("<id2>", opts("auto-edit"));
    const { waitFor } = collect(s);
    await s.send({ text: "What was the codeword? Reply with just the word." });
    expect(await waitFor((e) => e.type === "message.completed")).toMatchObject({ text: "PLUM" });
    await s.dispose();
  });
});
