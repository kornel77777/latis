import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentEvent, type AgentSession, type PermissionMode } from "@lattiz/shared";
import { AcpAdapter } from "../../src/main/agents/adapters/acp";
import { AcpMapper, diffHunks, type SessionUpdate } from "../../src/main/agents/adapters/acp/mapper";
import { BUILT_IN_MANIFESTS, loadManifests, type AgentManifest } from "../../src/main/agents/manifests";
import { ReplayLibrary, replayTransport } from "../../src/main/agents/rpc/replay";

const CWD = "/repo";
const DIR = fileURLToPath(new URL("../../../../fixtures/acp", import.meta.url));
type Line = { dir: string; msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> } };

function fixture(name: string): Line[] {
  return readFileSync(`${DIR}/${name}.jsonl`, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l.replaceAll("<cwd>", CWD)) as Line);
}

/** Maps a recording the way the adapter does: updates, permission requests, and the prompt result as turn end. */
function mapAll(name: string): AgentEvent[] {
  const m = new AcpMapper(CWD);
  const lines = fixture(name);
  const promptIds = new Set(lines.filter((l) => l.dir === "out" && l.msg.method === "session/prompt").map((l) => l.msg.id));
  let loading = false;
  return lines.flatMap(({ dir, msg }) => {
    if (dir === "out" && msg.method === "session/load") loading = true;
    if (dir !== "in") return [];
    if (msg.method === "session/update") return loading ? [] : m.update(msg.params!.update as SessionUpdate);
    if (msg.method === "session/request_permission") {
      const call = msg.params!.toolCall as { toolCallId: string };
      return m.permission(call.toolCallId, call);
    }
    if (msg.method === undefined && msg.result && "stopReason" in msg.result && promptIds.has(msg.id)) {
      return m.turnEnd(String(msg.result.stopReason), 1);
    }
    if (msg.method === undefined && msg.result && "sessionId" in msg.result) loading = false;
    return [];
  });
}

describe("diffHunks", () => {
  it("computes unified hunks for a new and an edited file", () => {
    expect(diffHunks(null, "a\nb\n")[0]).toMatchObject({ oldStart: 0, newStart: 1, lines: ["+a", "+b"] });
    expect(diffHunks("a\nb\n", "a\nc\n")[0]!.lines).toEqual([" a", "-b", "+c"]);
  });
});

describe("AcpMapper", () => {
  it.each(["write-run", "deny", "cancel", "resume", "gemini-write-run", "gemini-deny", "gemini-resume"])(
    "maps %s to schema-valid events",
    (name) => {
      const events = mapAll(name);
      for (const e of events) expect(AgentEvent.safeParse(e).success).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
    },
  );

  it("starts steps once real input arrives and attaches the written file's diff", () => {
    const events = mapAll("write-run");
    const started = events.filter((e) => e.type === "tool.started");
    expect(started.map((e) => e.type === "tool.started" && [e.kind, e.name])).toEqual([
      ["edit", "Write hello.txt"],
      ["exec", "wc -l hello.txt"],
    ]);
    expect(started[0]).toMatchObject({ paths: ["hello.txt"] });
    expect(events.find((e) => e.type === "file.changed")).toMatchObject({
      path: "hello.txt",
      change: "created",
      additions: 1,
      deletions: 0,
    });
    expect(events.find((e) => e.type === "permission.requested")).toMatchObject({ kind: "edit", summary: "Write hello.txt" });
  });

  it("completes the streamed message before a tool and at turn end", () => {
    const events = mapAll("write-run");
    const final = events.filter((e) => e.type === "message.completed").at(-1);
    expect(final).toMatchObject({ text: expect.stringContaining("hello.txt") });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ costUsd: expect.any(Number) });
  });

  it("maps Gemini's tool calls: a created file with its diff, shell commands as exec", () => {
    const events = mapAll("gemini-write-run");
    const change = events.find((e) => e.type === "file.changed");
    expect(change, JSON.stringify(change)).toMatchObject({ path: "hello.txt", change: "created", additions: 1 });
    expect(events.filter((e) => e.type === "tool.started").map((e) => e.type === "tool.started" && e.kind)).toEqual(["edit", "exec"]);
    expect(mapAll("gemini-deny").find((e) => e.type === "tool.completed")).toMatchObject({ status: "denied" });
  });

  it("marks a refused tool as denied", () => {
    expect(mapAll("deny").find((e) => e.type === "tool.completed")).toMatchObject({ status: "denied" });
  });

  it("maps a cancelled prompt to an interrupted turn", () => {
    expect(mapAll("cancel").at(-1)).toMatchObject({ type: "turn.completed", status: "interrupted" });
  });

  it("drops the history an agent replays during session/load", () => {
    const texts = mapAll("resume").filter((e) => e.type === "message.completed");
    expect(texts.map((e) => e.type === "message.completed" && e.text)).toEqual(["OK", "PLUM"]);
  });
});

describe("manifests", () => {
  it("loads valid user manifests, reports bad ones, and keeps built-in ids reserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "lattiz-manifests-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mine.json"),
      JSON.stringify({ id: "acp:mine", displayName: "Mine", protocol: "acp", command: "mine", args: ["--acp"] }),
    );
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ id: "Bad Id", protocol: "nope" }));
    writeFileSync(join(dir, "clash.json"), JSON.stringify({ id: "codex", displayName: "X", protocol: "acp", command: "x" }));
    writeFileSync(join(dir, "broken.json"), "{");
    const { manifests, errors } = loadManifests(dir, ["codex", "claude-code"]);
    expect(manifests.map((m) => m.id)).toEqual([...BUILT_IN_MANIFESTS.map((m) => m.id), "acp:mine"]);
    expect(manifests.at(-1)).toMatchObject({ hue: "violet", detect: { versionArgs: ["--version"] } });
    expect(Object.keys(errors).sort()).toEqual(["bad.json", "broken.json", "clash.json"]);
  });
});

const MANIFEST: AgentManifest = { ...BUILT_IN_MANIFESTS[0]!, id: "acp:test", displayName: "Test agent" };
function adapter() {
  const lib = new ReplayLibrary(DIR, {
    fallback: "write-run",
    turnMethod: "session/prompt",
    paceMs: 0,
    stubs: { "session/set_mode": {}, "session/set_config_option": {} },
    include: (n) => !n.startsWith("gemini-"),
  });
  return new AcpAdapter(MANIFEST, {
    transport: (cwd) => replayTransport(lib, cwd),
    executable: "/replay/acp",
    probeDir: mkdtempSync(join(tmpdir(), "lattiz-probe-")),
  });
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

describe("AcpAdapter (replayed Gemini CLI)", () => {
  const gemini = (stubs?: Record<string, unknown>) => {
    const lib = new ReplayLibrary(DIR, {
      fallback: "gemini-write-run",
      turnMethod: "session/prompt",
      paceMs: 0,
      include: (n) => n.startsWith("gemini-"),
      ...(stubs && { stubs }),
    });
    return new AcpAdapter(BUILT_IN_MANIFESTS[0]!, {
      transport: (cwd) => replayTransport(lib, cwd),
      executable: "/replay/gemini",
      probeDir: mkdtempSync(join(tmpdir(), "lattiz-probe-")),
    });
  };

  it("lists models from the older models field and picks them with session/set_model", async () => {
    const models = await gemini().listModels();
    expect(models.map((m) => m.id)).toContain("gemini-3.5-flash-lite");
  });

  it("opens even when Gemini refuses Auto-edit in an untrusted folder, and still auto-allows in-folder edits", async () => {
    // No stub for session/set_mode: the replay answers it with an error, as Gemini does in untrusted folders.
    const s = await gemini().startSession(opts("auto-edit"));
    const { events, waitFor } = collect(s);
    await s.send({ text: "write hello.txt" });
    await waitFor((e) => e.type === "turn.completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(0);
    expect(events.find((e) => e.type === "file.changed")).toMatchObject({ change: "created" });
    await s.dispose();
  });

  it("remembers 'always for this chat' itself and answers with allow-once", async () => {
    const s = await gemini({ "session/set_mode": {} }).startSession(opts("ask"));
    const { waitFor } = collect(s);
    await s.send({ text: "write hello.txt" });
    const req = await waitFor((e) => e.type === "permission.requested");
    await s.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "allow-chat" });
    expect(await waitFor((e) => e.type === "tool.completed")).toMatchObject({ status: "ok" });
    await s.dispose();
  });
});

describe("AcpAdapter (replayed agent)", () => {
  it("reports sign-in and lists models with effort levels from config options", async () => {
    const a = adapter();
    expect(await a.authStatus()).toMatchObject({ signedIn: true });
    const models = await a.listModels();
    expect(models[0]).toMatchObject({ id: "default" });
    expect(models.find((m) => m.id === "haiku")?.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("round-trips a permission and finishes the turn", async () => {
    const s = await adapter().startSession(opts("ask"));
    const { events, waitFor } = collect(s);
    expect(s.nativeSessionId).toBe("<id0>");
    await s.send({ text: "write hello.txt" });
    const req = await waitFor((e) => e.type === "permission.requested");
    await s.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "allow-once" });
    expect(await waitFor((e) => e.type === "turn.completed")).toMatchObject({ status: "ok" });
    expect(events.find((e) => e.type === "file.changed")).toMatchObject({ path: "hello.txt" });
    await s.dispose();
  });

  it("asks about always-ask commands in Full-auto and allows the rest", async () => {
    const listed = await adapter().startSession({ cwd: CWD, permissionMode: "full-auto", alwaysAsk: ["git push", "printf"] });
    const a = collect(listed);
    await listed.send({ text: "/deny" });
    const req = await a.waitFor((e) => e.type === "permission.requested");
    expect(req).toMatchObject({ kind: "exec", command: expect.stringContaining("printf 'secret'"), alwaysAsk: "printf" });
    await listed.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "allow-once" });
    await a.waitFor((e) => e.type === "turn.completed");
    await listed.dispose();

    const unlisted = await adapter().startSession({ cwd: CWD, permissionMode: "full-auto", alwaysAsk: ["git push"] });
    const b = collect(unlisted);
    await unlisted.send({ text: "/deny" });
    await b.waitFor((e) => e.type === "turn.completed");
    expect(b.events.filter((e) => e.type === "permission.requested")).toHaveLength(0);
    await unlisted.dispose();
  });

  it("emulates Auto-edit by allowing in-folder edits itself", async () => {
    const s = await adapter().startSession(opts("auto-edit"));
    const { events, waitFor } = collect(s);
    await s.send({ text: "write hello.txt" });
    await waitFor((e) => e.type === "turn.completed");
    expect(events.filter((e) => e.type === "permission.requested")).toHaveLength(0);
    await s.dispose();
  });

  it("rejects with the agent's reject option", async () => {
    const s = await adapter().startSession(opts("ask"));
    const { waitFor } = collect(s);
    await s.send({ text: "/deny" });
    const req = await waitFor((e) => e.type === "permission.requested");
    await s.respond(req.type === "permission.requested" ? req.id : "", { kind: "permission", decision: "deny" });
    expect(await waitFor((e) => e.type === "tool.completed")).toMatchObject({ status: "denied" });
    await s.dispose();
  });

  it("cancels a running prompt", async () => {
    const s = await adapter().startSession(opts("full-auto"));
    const { waitFor } = collect(s);
    await s.send({ text: "/cancel" });
    await waitFor((e) => e.type === "tool.completed");
    await s.interrupt();
    expect(await waitFor((e) => e.type === "turn.completed")).toMatchObject({ status: "interrupted" });
    await s.dispose();
  });

  it("loads a session without replaying its history into the chat", async () => {
    const s = await adapter().resumeSession!("<id0>", opts("ask"));
    const { events, waitFor } = collect(s);
    await s.send({ text: "What was the codeword? Reply with just the word." });
    expect(await waitFor((e) => e.type === "message.completed")).toMatchObject({ text: "PLUM" });
    expect(events.filter((e) => e.type === "message.completed")).toHaveLength(1);
    await s.dispose();
  });
});
