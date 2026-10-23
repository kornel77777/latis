import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Scheduler } from "../../src/main/scheduler";
import { openDb } from "../../src/main/store/db";
import { WorkspaceStore } from "../../src/main/store/workspace";

function setup(start: number) {
  const store = new WorkspaceStore(openDb(join(mkdtempSync(join(tmpdir(), "latis-sched-")), "latis.db")));
  let now = start;
  const sent: [string, string][] = [];
  const notes: string[] = [];
  const s = new Scheduler({
    store,
    deliver: async (chatId, text) => void sent.push([chatId, text]),
    note: (_c, t) => void notes.push(t),
    changed: () => undefined,
    now: () => now,
  });
  return { s, store, sent, notes, advance: (ms: number) => (now += ms) };
}

describe("Scheduler", () => {
  it("sends due messages once and keeps the rest", async () => {
    const { s, sent, advance } = setup(1_000_000);
    s.add({ chatId: "c", text: "soon", fireAt: 1_060_000, repeatMs: null, onReset: false });
    s.add({ chatId: "c", text: "later", fireAt: 9_000_000, repeatMs: null, onReset: false });
    await s.tick();
    expect(sent).toEqual([]);
    advance(61_000);
    await s.tick();
    await s.tick();
    expect(sent).toEqual([["c", "soon"]]);
    expect(s.list().map((m) => m.text)).toEqual(["later"]);
  });

  it("a missed message goes out once on launch, with a note; repeats skip to the next slot", async () => {
    const hour = 3_600_000;
    const { s, sent, notes, store } = setup(10 * hour);
    store.addScheduled({ chatId: "c", text: "missed", fireAt: 2 * hour, repeatMs: null, onReset: false });
    store.addScheduled({ chatId: "c", text: "hourly", fireAt: 7.5 * hour, repeatMs: hour, onReset: false });
    await s.tick();
    expect(sent.map((x) => x[1])).toEqual(["missed", "hourly"]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/late because Latis wasn't running/);
    expect(s.list()).toEqual([expect.objectContaining({ text: "hourly", fireAt: 10.5 * hour })]);
  });

  it("forgets a deleted chat's messages and can cancel one", () => {
    const { s } = setup(0);
    const a = s.add({ chatId: "a", text: "x", fireAt: 1e12, repeatMs: null, onReset: false });
    s.add({ chatId: "b", text: "y", fireAt: 1e12, repeatMs: null, onReset: false });
    s.forgetChat("b");
    expect(s.cancel(a.id)).toBe(true);
    expect(s.list()).toEqual([]);
  });
});
