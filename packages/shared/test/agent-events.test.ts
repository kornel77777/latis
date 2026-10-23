import { describe, expect, it } from "vitest";
import { AgentEvent, coalesceEvents, nextStatus, type StoredEvent } from "../src";

const se = (seq: number, event: AgentEvent, turnId: string | null = "t1"): StoredEvent => ({ chatId: "c1", seq, ts: seq, turnId, event });

describe("AgentEvent schema", () => {
  it("accepts every documented shape", () => {
    const samples: unknown[] = [
      { type: "session.started", model: "m" },
      { type: "message.delta", text: "hi" },
      { type: "tool.started", id: "1", kind: "exec", name: "Bash", input: { command: "ls" } },
      { type: "tool.completed", id: "1", status: "denied" },
      { type: "permission.requested", id: "p", kind: "exec", summary: "Run ls" },
      { type: "rate_limited", message: "limit", resetsAt: "2026-10-22T18:00:00Z" },
      { type: "turn.completed", status: "ok", durationMs: 10 },
      { type: "error", message: "boom", recoverable: false },
    ];
    for (const s of samples) expect(AgentEvent.safeParse(s).success).toBe(true);
  });

  it("rejects unknown types and bad enums", () => {
    expect(AgentEvent.safeParse({ type: "nope" }).success).toBe(false);
    expect(AgentEvent.safeParse({ type: "tool.started", id: "1", kind: "teleport", name: "x", input: null }).success).toBe(false);
  });
});

describe("nextStatus", () => {
  it("follows the state machine", () => {
    expect(nextStatus("idle", { type: "message.delta", text: "a" })).toBe("working");
    expect(nextStatus("working", { type: "permission.requested", id: "p", kind: "exec", summary: "s" })).toBe("needs-you");
    expect(nextStatus("working", { type: "turn.completed", status: "ok", durationMs: 1 })).toBe("done");
    expect(nextStatus("working", { type: "turn.completed", status: "error", durationMs: 1 })).toBe("error");
    expect(nextStatus("working", { type: "error", message: "x", recoverable: true })).toBe("working");
    expect(nextStatus("working", { type: "error", message: "x", recoverable: false })).toBe("error");
    expect(nextStatus("done", { type: "usage", outputTokens: 3 })).toBe("done");
  });
});

describe("coalesceEvents", () => {
  it("merges consecutive deltas of the same kind and keeps the last seq", () => {
    const out = coalesceEvents([
      se(0, { type: "message.delta", text: "Hel" }),
      se(1, { type: "message.delta", text: "lo" }),
      se(2, { type: "thinking.delta", text: "hm" }),
      se(3, { type: "message.delta", text: "!" }),
    ]);
    expect(out.map((e) => e.event)).toEqual([
      { type: "message.delta", text: "Hello" },
      { type: "thinking.delta", text: "hm" },
      { type: "message.delta", text: "!" },
    ]);
    expect(out[0]!.seq).toBe(1);
  });

  it("does not merge across turns", () => {
    const out = coalesceEvents([se(0, { type: "message.delta", text: "a" }, "t1"), se(1, { type: "message.delta", text: "b" }, "t2")]);
    expect(out).toHaveLength(2);
  });
});
