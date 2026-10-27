import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FlowSpec } from "@lattiz/shared";
import { Cards } from "../../src/main/cards/cards";
import { gateCard } from "../../src/main/cards/library";
import { buildFlow, columns } from "../../src/main/flows/build";
import { FlowEngine, nextRun } from "../../src/main/flows/engine";
import { TEMPLATES } from "../../src/main/flows/templates";
import { openDb } from "../../src/main/store/db";
import { WorkspaceStore } from "../../src/main/store/workspace";

/** A flow with stub agents: the test answers for each chat by title. */
async function setup(spec: FlowSpec, opts: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lattiz-flow-"));
  const store = new WorkspaceStore(openDb(join(dir, "lattiz.db")));
  const canvasId = store.ensureDefaultCanvas();
  const cards = new Cards(store, join(dir, "cards"), { confirm: async () => true });
  const sent: { chat: string; text: string }[] = [];
  const busy = new Set<string>();
  const interrupted: string[] = [];
  const engine = new FlowEngine({
    store,
    send: async (chatId, text) => {
      sent.push({ chat: store.getChat(chatId)!.title, text });
      busy.add(chatId);
    },
    interrupt: async (chatId) => void interrupted.push(chatId),
    busy: (chatId) => busy.has(chatId),
    appendNote: (nodeId, md) => store.updateNodeData(nodeId, { text: `${String(store.getNode(nodeId)!.data.text).trimEnd()}\n\n${md}\n` }),
    cardReceive: (nodeId, items, mode) => {
      const id = String(store.getNode(nodeId)!.data.cardId);
      const key = mode === "gate" ? "inbox" : "items";
      cards.dataSet(id, key, [...((cards.dataGet(id, key) as unknown[]) ?? []), ...items]);
    },
    changed: () => undefined,
    ...(opts.now && { now: opts.now }),
  });
  const built = await buildFlow(
    {
      store,
      dataDir: dir,
      canvasId,
      readyAgents: async () => ["stub"],
      defaultMode: () => "ask",
      createCard: ({ title, gate, x, y, parentId }) => cards.create({ canvasId, title, html: gateCard(gate)!.html, gate, x, y, parentId }),
    },
    spec,
    0,
    0,
  );
  const chatId = (title: string) => built.chats.find((c) => c.title === title)!.id;
  const answer = (title: string, text: string, status: "ok" | "error" = "ok") => {
    busy.delete(chatId(title));
    engine.turnEnded(chatId(title), status, text);
  };
  const info = () => store.flowInfo(built.flow.id)!;
  const note = (title: string) => {
    const n = built.nodes.find((x) => x.type === "note" && String(x.data.text).startsWith(`# ${title}`))!;
    return String(store.getNode(n.id)!.data.text);
  };
  return { store, engine, built, sent, answer, info, note, cards, interrupted, flowId: built.flow.id };
}

const chain = (...names: string[]): FlowSpec => ({
  name: "Chain",
  brief: "Keep it short.",
  nodes: [
    { id: "start", type: "start" },
    ...names.map((n) => ({ id: n, type: "chat" as const, title: n, job: `Be ${n}.` })),
    { id: "out", type: "note", title: "Out" },
  ],
  edges: [
    { from: "start", to: names[0]! },
    ...names.slice(1).map((n, i) => ({ from: names[i]!, to: n })),
    { from: names.at(-1)!, to: "out" },
  ],
});

describe("flows engine", () => {
  it("lays nodes out left to right by depth", () => {
    expect([...columns(chain("a", "b")).entries()]).toEqual([
      ["start", 0],
      ["a", 1],
      ["b", 2],
      ["out", 3],
    ]);
  });

  it("pipeline: each output goes to the next node with the brief and job; the note collects; the run finishes", async () => {
    const f = await setup(chain("research", "write"));
    f.engine.start(f.flowId, "Owls", "you");
    expect(f.sent).toEqual([{ chat: "research", text: "[Flow: Chain]\n\nBrief: Keep it short.\n\nYour job: Be research.\n\nOwls" }]);
    f.answer("research", "Owls can turn their heads 270°.");
    expect(f.sent[1]!.chat).toBe("write");
    expect(f.sent[1]!.text).toContain("## From research\n\nOwls can turn their heads 270°.");
    expect(f.info().run!.status).toBe("running");
    f.answer("write", "A short post about owls.");
    expect(f.note("Out")).toMatch(/### From write · .+\n\nA short post about owls\./);
    expect(f.info().run!.status).toBe("done");
    expect(() => f.engine.start(f.flowId, "again", "you")).not.toThrow();
  });

  it("wait_all joins every input into one message; free shares tasks among idle workers", async () => {
    const council = await setup(TEMPLATES.find((t) => t.id === "council")!.spec);
    council.engine.start(council.flowId, "Should we rewrite it?", "you");
    for (const r of ["Builder", "Skeptic", "Simplifier"]) council.answer(r, `${r} says so.`);
    expect(council.sent.some((s) => s.chat === "Synthesiser")).toBe(false);
    council.answer("User advocate", "Users want speed.");
    const synth = council.sent.find((s) => s.chat === "Synthesiser")!.text;
    expect(synth).toContain("## From Builder\n\nBuilder says so.");
    expect(synth).toContain("## From User advocate\n\nUsers want speed.");
    council.answer("Synthesiser", "Decision: don't rewrite.");
    expect(council.note("Decision")).toContain("Decision: don't rewrite.");

    const team = await setup(TEMPLATES.find((t) => t.id === "team")!.spec);
    team.engine.start(team.flowId, "t1\nt2\nt3\nt4\nt5", "you");
    // Three workers, five tasks: each idle worker gets one, two wait.
    expect(team.sent.map((s) => s.chat)).toEqual(["Worker 1", "Worker 2", "Worker 3"]);
    team.answer("Worker 2", "did t2");
    expect(team.sent.at(-1)).toMatchObject({ chat: "Worker 2" });
    expect(team.sent.at(-1)!.text).toContain("t4");
    for (const w of ["Worker 1", "Worker 3", "Worker 2"]) team.answer(w, `${w} done`);
    team.answer("Worker 1", "did t5");
    const results = team.built.nodes.find((n) => n.type === "card")!;
    expect((team.cards.dataGet(String(results.data.cardId), "items") as unknown[]).length).toBe(5);
    expect(team.info().run!.status).toBe("done");
  });

  it("approval edges wait for Keep (edited), Send back with feedback, or Drop", async () => {
    const spec = chain("writer");
    spec.edges.at(-1)!.mode = "approval";
    const f = await setup(spec);
    f.engine.start(f.flowId, "go", "you");
    f.answer("writer", "Draft 1");
    const [a] = f.info().run!.approvals;
    expect(a).toMatchObject({ from: "writer", to: "Out", text: "Draft 1" });
    f.engine.approve(f.flowId, a!.id, "sendBack", "Shorter please.");
    expect(f.sent.at(-1)!.text).toContain("Feedback on your last answer: Shorter please.");
    f.answer("writer", "Draft 2");
    const b = f.info().run!.approvals[0]!;
    f.engine.approve(f.flowId, b.id, "keep", undefined, "Draft 2 (edited)");
    expect(f.note("Out")).toContain("Draft 2 (edited)");
    expect(f.info().run!.status).toBe("done");
  });

  it("the loop guard pauses a cycle; [flow done] ends it", async () => {
    const f = await setup({
      name: "Loop",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "chat", title: "A" },
        { id: "b", type: "chat", title: "B" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    });
    f.store.updateFlow(f.flowId, { loopLimit: 3 });
    f.engine.start(f.flowId, "ping", "you");
    f.answer("A", "1");
    f.answer("B", "2");
    f.answer("A", "3");
    expect(f.info().run!.loopCheck).toBe(true);
    expect(f.sent.at(-1)!.chat).toBe("A");
    f.engine.loop(f.flowId, true);
    expect(f.sent.at(-1)!.chat).toBe("B");
    f.answer("B", "All good. [flow done]");
    expect(f.info().run!.status).toBe("done");
  });

  it("pause holds handoffs, resume releases them, stop interrupts and drops", async () => {
    const f = await setup(chain("a", "b"));
    f.engine.start(f.flowId, "x", "you");
    f.engine.control(f.flowId, "pause");
    f.answer("a", "out of a");
    expect(f.sent.map((s) => s.chat)).toEqual(["a"]);
    f.engine.control(f.flowId, "resume");
    expect(f.sent.map((s) => s.chat)).toEqual(["a", "b"]);
    f.engine.control(f.flowId, "stop");
    expect(f.interrupted).toHaveLength(1);
    expect(f.info().run!.status).toBe("stopped");
    expect(f.info().run!.log.at(-1)!.text).toMatch(/Stopped/);
  });

  it("a gate card holds items until the user sends one on", async () => {
    const f = await setup({
      name: "Gate",
      nodes: [
        { id: "start", type: "start" },
        { id: "w", type: "chat", title: "W" },
        { id: "pick", type: "card", gate: "pick", title: "Pick one" },
        { id: "out", type: "note", title: "Out" },
      ],
      edges: [
        { from: "start", to: "w" },
        { from: "w", to: "pick" },
        { from: "pick", to: "out" },
      ],
    });
    f.engine.start(f.flowId, "x", "you");
    f.answer("W", "Option A");
    expect(f.info().run!.status).toBe("running");
    const card = f.built.nodes.find((n) => n.type === "card")!;
    expect(f.cards.dataGet(String(card.data.cardId), "inbox")).toEqual([expect.objectContaining({ text: "Option A", label: "W" })]);
    f.engine.fromCard(card.id, { text: "Option A" });
    expect(f.note("Out")).toContain("Option A");
    expect(f.info().run!.status).toBe("done");
  });

  it("restarts re-send in-flight items; schedules fire once, even when missed", async () => {
    let now = new Date(2026, 9, 23, 7, 0).getTime();
    const f = await setup({ ...chain("a"), schedule: { every: "daily", at: "08:00" } }, { now: () => now });
    f.store.updateFlow(f.flowId, { nextRunAt: new Date(2026, 9, 23, 8, 0).getTime() });
    f.engine.tick();
    expect(f.sent).toHaveLength(0);
    now = new Date(2026, 9, 24, 9, 30).getTime(); // Lattiz was closed through 08:00
    f.engine.tick();
    f.engine.tick();
    expect(f.sent).toHaveLength(1);
    expect(f.info().run!.trigger).toBe("schedule");
    expect(
      f
        .info()
        .run!.log.map((l) => l.text)
        .join("\n"),
    ).toMatch(/while Lattiz was closed/);
    expect(f.info().nextRunAt).toBe(new Date(2026, 9, 25, 8, 0).getTime());
    f.engine.resumeAll();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]!.text).toBe(f.sent[0]!.text);
  });
});

describe("nextRun", () => {
  const at = (h: number, m: number, day = 23) => new Date(2026, 9, day, h, m).getTime();
  it("hourly, daily and weekly", () => {
    expect(nextRun({ every: "hourly", at: "00:15" }, at(9, 20))).toBe(at(10, 15));
    expect(nextRun({ every: "daily", at: "08:00" }, at(7, 59))).toBe(at(8, 0));
    expect(nextRun({ every: "daily", at: "08:00" }, at(8, 0))).toBe(at(8, 0, 24));
    // 2026-10-23 is a Friday; next Monday 09:00 is the 26th.
    expect(nextRun({ every: "weekly", at: "09:00", weekday: 1 }, at(10, 0))).toBe(at(9, 0, 26));
  });
});
