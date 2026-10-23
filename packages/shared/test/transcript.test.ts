import { describe, expect, it } from "vitest";
import { buildTranscript, type AgentEvent, type StoredEvent, type Turn } from "../src";

const turn: Turn = { id: "t1", chatId: "c", seq: 0, userText: "do it", startedAt: 0, endedAt: null, status: "running" };
let seq = 0;
const ev = (event: AgentEvent): StoredEvent => ({ chatId: "c", seq: seq++, ts: 0, turnId: "t1", event });

describe("buildTranscript", () => {
  it("projects a full turn", () => {
    seq = 0;
    const items = buildTranscript(
      [turn],
      [
        ev({ type: "message.delta", text: "Hi " }),
        ev({ type: "message.delta", text: "there" }),
        ev({ type: "tool.started", id: "x", kind: "edit", name: "Write", input: {}, paths: ["a.ts"] }),
        ev({ type: "permission.requested", id: "p", kind: "exec", summary: "Run ls" }),
        ev({ type: "tool.completed", id: "x", status: "ok" }),
        ev({ type: "usage", outputTokens: 7 }),
        ev({ type: "turn.completed", status: "ok", durationMs: 1200 }),
      ],
    );
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "step", "permission", "turn-end"]);
    expect(items[1]).toMatchObject({ text: "Hi there", streaming: false });
    expect(items[2]).toMatchObject({ status: "ok", paths: ["a.ts"] });
    expect(items[3]).toMatchObject({ pending: false });
    expect(items[4]).toMatchObject({ outputTokens: 7, durationMs: 1200 });
  });

  it("keeps a trailing permission pending and a trailing message streaming", () => {
    seq = 0;
    const a = buildTranscript([turn], [ev({ type: "permission.requested", id: "p", kind: "exec", summary: "s" })]);
    expect(a.at(-1)).toMatchObject({ kind: "permission", pending: true });
    const b = buildTranscript([turn], [ev({ type: "message.delta", text: "…" })]);
    expect(b.at(-1)).toMatchObject({ kind: "assistant", streaming: true });
  });

  it("marks running steps as errored when the agent dies", () => {
    seq = 0;
    const items = buildTranscript(
      [turn],
      [
        ev({ type: "tool.started", id: "x", kind: "exec", name: "Bash", input: {} }),
        ev({ type: "error", message: "exited", recoverable: false }),
      ],
    );
    expect(items[1]).toMatchObject({ kind: "step", status: "error" });
  });
});
