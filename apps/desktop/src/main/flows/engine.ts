import { randomUUID } from "node:crypto";
import type { CanvasNode, FlowEdge, FlowSchedule } from "@lattiz/shared";
import type { WorkspaceStore } from "../store/workspace";

// The flows engine (SPEC §11). A run moves items along a flow's edges: when a node produces
// output (a chat's final message, a gate card's choice), it goes to the nodes its edges point at.
// Everything a run is waiting on lives in `flow_runs.state_json`, so runs survive restarts.

export interface Item {
  id: string;
  text: string;
  /** The node it came from (null for the Start input). */
  from: string | null;
  /** Who sent it, for headers and labels. */
  label: string;
}

interface RunState {
  /** Items delivered to a chat whose answer hasn't come back yet, by chat node. */
  inflight: Record<string, Item[][]>;
  /** Items waiting on approval edges. */
  approvals: { id: string; edgeId: string; item: Item; to: string }[];
  /** Items for `free` edges with no idle target yet. */
  freeQueue: { source: string; item: Item }[];
  /** wait_all joins: target node → edge id → item. */
  joins: Record<string, Record<string, Item>>;
  /** Outputs held while paused, or by the loop guard. */
  held: { nodeId: string; item: Item }[];
  /** Gate cards with items waiting for the user. */
  gates: string[];
  handoffs: number;
  loopCheck: boolean;
}

type Status = "running" | "paused" | "done" | "stopped" | "error";

interface Run {
  id: string;
  flowId: string;
  status: Status;
  state: RunState;
  log: { at: number; text: string }[];
}

export interface EngineDeps {
  store: WorkspaceStore;
  /** Sends now if idle, otherwise after the chat's current turn. */
  send(chatId: string, text: string): Promise<unknown>;
  interrupt(chatId: string): Promise<unknown>;
  busy(chatId: string): boolean;
  /** Appends to a note and shows it. */
  appendNote(nodeId: string, markdown: string): void;
  /** Gives items to a card (gate or results) and tells it. */
  cardReceive(nodeId: string, items: Item[], mode: "gate" | "collect"): void;
  changed(flowId: string): void;
  now?(): number;
}

const DONE = /\[flow done\]/i;

const omit = <T>(o: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const LATE_MS = 2 * 60_000;
const emptyState = (): RunState => ({
  inflight: {},
  approvals: [],
  freeQueue: [],
  joins: {},
  held: [],
  gates: [],
  handoffs: 0,
  loopCheck: false,
});

/** The next time a schedule fires after `from` (local time). */
export function nextRun(s: FlowSchedule, from: number): number {
  const [h, m] = s.at.split(":").map(Number) as [number, number];
  const d = new Date(from);
  d.setSeconds(0, 0);
  if (s.every === "hourly") {
    d.setMinutes(m);
    if (d.getTime() <= from) d.setHours(d.getHours() + 1);
    return d.getTime();
  }
  d.setHours(h, m);
  if (s.every === "daily") {
    if (d.getTime() <= from) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const want = s.weekday ?? 1;
  d.setDate(d.getDate() + ((want - d.getDay() + 7) % 7));
  if (d.getTime() <= from) d.setDate(d.getDate() + 7);
  return d.getTime();
}

export class FlowEngine {
  constructor(private readonly d: EngineDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private load(runId: string): Run | undefined {
    const r = this.d.store.run(runId);
    return (
      r && {
        id: r.id,
        flowId: r.flowId,
        status: r.status as Status,
        state: JSON.parse(r.stateJson) as RunState,
        log: JSON.parse(r.logJson) as Run["log"],
      }
    );
  }

  private active(flowId: string): Run | undefined {
    const r = this.d.store.latestRun(flowId);
    return r && (r.status === "running" || r.status === "paused") ? this.load(r.id) : undefined;
  }

  private save(run: Run) {
    const ended = run.status === "done" || run.status === "stopped" || run.status === "error";
    this.d.store.saveRun(run.id, {
      status: run.status,
      stateJson: JSON.stringify(run.state),
      logJson: JSON.stringify(run.log.slice(-500)),
      ...(ended && { endedAt: this.now() }),
    });
    this.d.changed(run.flowId);
  }

  private log(run: Run, text: string) {
    run.log.push({ at: this.now(), text });
  }

  // ── Graph ──────────────────────────────────────────────────────────────────

  private flowOf(flowId: string) {
    const f = this.d.store.flowRow(flowId);
    if (!f) throw new Error("That flow no longer exists.");
    return f;
  }

  private node(id: string): CanvasNode | undefined {
    return this.d.store.getNode(id);
  }

  private chatOf(nodeId: string): string | undefined {
    const n = this.node(nodeId);
    return n?.type === "chat" && typeof n.data.chatId === "string" ? n.data.chatId : undefined;
  }

  private titleOf(nodeId: string): string {
    const n = this.node(nodeId);
    if (!n) return "a deleted node";
    if (n.type === "chat") return this.d.store.getChat(String(n.data.chatId))?.title ?? "Chat";
    if (n.type === "start") return "Start";
    if (n.type === "note")
      return (
        String(n.data.text ?? "")
          .split("\n")[0]
          ?.replace(/^#+\s*/, "") || "Note"
      );
    return String(n.data.title ?? n.type);
  }

  private edges(flowId: string): FlowEdge[] {
    return this.d.store.edgesOf(flowId);
  }

  /** The flow a node belongs to (its frame), if any. */
  private flowOfNode(nodeId: string) {
    const n = this.node(nodeId);
    return n?.parentId ? this.d.store.flowByNode(n.parentId) : undefined;
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  start(flowId: string, input: string | undefined, trigger: string): void {
    const f = this.flowOf(flowId);
    if (this.active(flowId)) throw new Error("This flow is already running. Stop it first.");
    const starts = this.members(f.nodeId).filter((n) => n.type === "start");
    if (!starts.length) throw new Error("This flow has no Start node.");
    const run: Run = { id: randomUUID(), flowId, status: "running", state: emptyState(), log: [] };
    this.d.store.insertRun({ id: run.id, flowId, status: "running", trigger, stateJson: "{}", startedAt: this.now() });
    this.log(run, trigger === "schedule" ? "Started by its schedule." : "Started.");
    for (const s of starts) {
      const text = (input ?? String(s.data.input ?? "")).trim() || `Run started ${new Date(this.now()).toLocaleString()}.`;
      const tasks = s.data.oneTaskPerLine
        ? text
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
        : [text];
      for (const t of tasks) this.route(run, s.id, { id: randomUUID(), text: t, from: null, label: "Start" });
    }
    this.finishIfIdle(run);
    this.save(run);
  }

  private members(frameNodeId: string): CanvasNode[] {
    return this.d.store.frameChildren(frameNodeId);
  }

  /** An output leaves `fromNode` along its edges (§11.2). */
  private route(run: Run, fromNode: string, item: Item) {
    if (run.status === "paused" || run.state.loopCheck) {
      run.state.held.push({ nodeId: fromNode, item });
      return;
    }
    const out = this.edges(run.flowId).filter((e) => e.source === fromNode);
    if (!out.length) return;
    // Loop guard (§11.3): too many handoffs in a row and the user decides.
    if (++run.state.handoffs > this.flowOf(run.flowId).loopLimit) {
      run.state.loopCheck = true;
      run.state.held.push({ nodeId: fromNode, item });
      this.log(run, `Paused after ${run.state.handoffs - 1} handoffs in a row. Continue or stop?`);
      return;
    }
    for (const e of out.filter((x) => x.mode !== "free")) {
      if (e.mode === "every") this.deliver(run, e.target, [item], e);
      else if (e.mode === "approval") {
        run.state.approvals.push({ id: randomUUID(), edgeId: e.id, item, to: this.titleOf(e.target) });
        this.log(run, `${item.label} → ${this.titleOf(e.target)} is waiting for your approval.`);
      } else this.join(run, e, item);
    }
    const free = out.filter((x) => x.mode === "free");
    if (free.length) this.deliverFree(run, fromNode, item, free);
  }

  /** `free`: the first idle target takes it; otherwise it waits (§11.2). */
  private deliverFree(run: Run, source: string, item: Item, free: FlowEdge[]): boolean {
    const idle = free.find((e) => {
      const chat = this.chatOf(e.target);
      return !chat || (!this.d.busy(chat) && !run.state.inflight[e.target]?.length);
    });
    if (!idle) {
      run.state.freeQueue.push({ source, item });
      return false;
    }
    this.deliver(run, idle.target, [item], idle);
    return true;
  }

  /** `wait_all`: the target gets everything at once when each wait_all edge has delivered (§11.2). */
  private join(run: Run, e: FlowEdge, item: Item) {
    const into = this.edges(run.flowId).filter((x) => x.target === e.target && x.mode === "wait_all");
    const got = { ...run.state.joins[e.target], [e.id]: item };
    if (into.every((x) => got[x.id])) {
      run.state.joins = omit(run.state.joins, e.target);
      this.deliver(
        run,
        e.target,
        into.map((x) => got[x.id]!),
        e,
      );
    } else {
      run.state.joins[e.target] = got;
      this.log(run, `${this.titleOf(e.target)} has ${Object.keys(got).length} of ${into.length} inputs.`);
    }
  }

  private deliver(run: Run, target: string, items: Item[], _edge?: FlowEdge) {
    const n = this.node(target);
    if (!n) return;
    const names = items.map((i) => i.label).join(", ");
    if (n.type === "chat") {
      const chatId = this.chatOf(target)!;
      (run.state.inflight[target] ??= []).push(items);
      this.log(run, `${names} → ${this.titleOf(target)}`);
      void this.d.send(chatId, this.compose(run, n, items)).catch((err: unknown) => {
        this.log(run, `Couldn't message ${this.titleOf(target)}: ${err instanceof Error ? err.message : String(err)}`);
        this.save(run);
      });
    } else if (n.type === "note") {
      const at = new Date(this.now()).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      for (const i of items) this.d.appendNote(target, `### From ${i.label} · ${at}\n\n${i.text.trim()}`);
      this.log(run, `${names} → note "${this.titleOf(target)}"`);
      for (const i of items) this.route(run, target, { ...i, from: target });
    } else if (n.type === "card") {
      const gate = String(n.data.gate ?? "");
      if (gate && gate !== "results") {
        this.d.cardReceive(target, items, "gate");
        if (!run.state.gates.includes(target)) run.state.gates.push(target);
        this.log(run, `${names} → ${this.titleOf(target)} (waiting for you)`);
      } else {
        this.d.cardReceive(target, items, "collect");
        this.log(run, `${names} → ${this.titleOf(target)}`);
      }
    }
  }

  /** The message a chat in a flow receives: brief, its job, then the item(s) (§11.1, §11.3). */
  private compose(run: Run, n: CanvasNode, items: Item[]): string {
    const f = this.flowOf(run.flowId);
    const job = String(n.data.job ?? "").trim();
    const parts = [
      `[Flow: ${f.name}]`,
      ...(f.brief.trim() ? [`Brief: ${f.brief.trim()}`] : []),
      ...(job ? [`Your job: ${job}`] : []),
      items.length === 1 && items[0]!.from === null
        ? items[0]!.text
        : items.map((i) => `## From ${i.label}\n\n${i.text.trim()}`).join("\n\n"),
    ];
    return parts.join("\n\n");
  }

  // ── Events from the rest of Lattiz ─────────────────────────────────────────

  /** A chat's turn ended: its final message is its output (supervisor hook). */
  turnEnded(chatId: string, status: "ok" | "interrupted" | "error", final: string | undefined): void {
    const chat = this.d.store.getChat(chatId);
    if (!chat) return;
    const flow = this.flowOfNode(chat.nodeId);
    const run = flow && this.active(flow.id);
    if (!run) return;
    const waiting = run.state.inflight[chat.nodeId];
    if (!waiting?.length) return; // a turn the user started themselves
    waiting.shift();
    if (!waiting.length) run.state.inflight = omit(run.state.inflight, chat.nodeId);
    if (status !== "ok" || !final?.trim()) {
      this.log(
        run,
        `${chat.title} ${status === "ok" ? "answered with nothing" : status === "interrupted" ? "was stopped" : "hit an error"}; its output goes nowhere.`,
      );
    } else if (DONE.test(final)) {
      this.log(run, `${chat.title} marked the flow done.`);
      run.status = "done";
      this.save(run);
      return;
    } else {
      this.route(run, chat.nodeId, { id: randomUUID(), text: final, from: chat.nodeId, label: chat.title });
    }
    this.drainFree(run);
    this.finishIfIdle(run);
    this.save(run);
  }

  /** A gate card sent its choice on (card bridge `sendToFlow`, §12.2). */
  fromCard(cardNodeId: string, payload: unknown): void {
    const flow = this.flowOfNode(cardNodeId);
    const run = flow && this.active(flow.id);
    if (!run) throw new Error("This card's flow isn't running.");
    const text =
      typeof payload === "string"
        ? payload
        : typeof (payload as { text?: unknown })?.text === "string"
          ? (payload as { text: string }).text
          : JSON.stringify(payload);
    if (!text.trim()) throw new Error("Send some text on.");
    run.state.gates = run.state.gates.filter((g) => g !== cardNodeId);
    this.log(run, `You sent "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}" on from ${this.titleOf(cardNodeId)}.`);
    this.route(run, cardNodeId, { id: randomUUID(), text, from: cardNodeId, label: this.titleOf(cardNodeId) });
    this.finishIfIdle(run);
    this.save(run);
  }

  private drainFree(run: Run) {
    const queue = run.state.freeQueue;
    run.state.freeQueue = [];
    for (const q of queue) {
      const free = this.edges(run.flowId).filter((e) => e.source === q.source && e.mode === "free");
      if (!this.deliverFree(run, q.source, q.item, free)) continue;
    }
  }

  private finishIfIdle(run: Run) {
    if (run.status !== "running") return;
    const s = run.state;
    const waiting = Object.keys(s.inflight).length + s.approvals.length + s.freeQueue.length + s.held.length + s.gates.length;
    if (waiting) return;
    for (const [target, got] of Object.entries(s.joins))
      this.log(run, `${this.titleOf(target)} never got all its inputs (${Object.keys(got).length} arrived).`);
    s.joins = {};
    run.status = "done";
    this.log(run, "Done.");
  }

  // ── User controls (§11.3) ──────────────────────────────────────────────────

  control(flowId: string, action: "pause" | "resume" | "stop"): void {
    const run = this.active(flowId);
    if (!run) throw new Error("This flow isn't running.");
    if (action === "pause") {
      run.status = "paused";
      this.log(run, "Paused. Handoffs wait until you resume.");
    } else if (action === "resume") {
      run.status = "running";
      this.log(run, "Resumed.");
      this.release(run);
    } else {
      for (const nodeId of Object.keys(run.state.inflight)) {
        const chat = this.chatOf(nodeId);
        if (chat) void this.d.interrupt(chat);
      }
      run.state = { ...emptyState(), handoffs: run.state.handoffs };
      run.status = "stopped";
      this.log(run, "Stopped. Waiting items were dropped.");
    }
    this.finishIfIdle(run);
    this.save(run);
  }

  private release(run: Run) {
    const held = run.state.held;
    run.state.held = [];
    for (const h of held) this.route(run, h.nodeId, h.item);
  }

  loop(flowId: string, go: boolean): void {
    const run = this.active(flowId);
    if (!run?.state.loopCheck) throw new Error("Nothing is waiting on the loop guard.");
    if (!go) return this.control(flowId, "stop");
    run.state.loopCheck = false;
    run.state.handoffs = 0;
    this.log(run, "You chose to continue.");
    this.release(run);
    this.finishIfIdle(run);
    this.save(run);
  }

  /** Approval edges: Keep (optionally edited), Send back with feedback, or Drop (§11.2). */
  approve(flowId: string, approvalId: string, action: "keep" | "sendBack" | "drop", feedback?: string, text?: string): void {
    const run = this.active(flowId);
    const a = run?.state.approvals.find((x) => x.id === approvalId);
    if (!run || !a) throw new Error("That item is no longer waiting.");
    run.state.approvals = run.state.approvals.filter((x) => x.id !== approvalId);
    const e = this.d.store.edge(a.edgeId);
    if (action === "keep" && e) {
      this.log(run, `You kept ${a.item.label}'s output for ${a.to}.`);
      this.deliver(run, e.target, [{ ...a.item, text: text?.trim() ? text : a.item.text }], e);
    } else if (action === "sendBack" && a.item.from && this.chatOf(a.item.from)) {
      this.log(run, `You sent ${a.item.label}'s output back with feedback.`);
      this.deliver(run, a.item.from, [
        {
          id: randomUUID(),
          from: null,
          label: "You",
          text: `Feedback on your last answer: ${feedback?.trim() || "Please improve it."}\n\nYour last answer was:\n\n${a.item.text}`,
        },
      ]);
    } else this.log(run, `You dropped ${a.item.label}'s output.`);
    this.finishIfIdle(run);
    this.save(run);
  }

  // ── Restarts and schedules ────────────────────────────────────────────────

  /** After a restart: chats can't still be working, so in-flight items go out again. */
  resumeAll(): void {
    for (const r of this.d.store.runsWithStatus(["running", "paused"])) {
      const run = this.load(r.id)!;
      const inflight = run.state.inflight;
      run.state.inflight = {};
      const n = Object.keys(inflight).length;
      if (n) this.log(run, `Lattiz restarted; ${n} chat${n === 1 ? "" : "s"} get${n === 1 ? "s" : ""} their input again.`);
      for (const [nodeId, batches] of Object.entries(inflight)) for (const items of batches) this.deliver(run, nodeId, items);
      this.finishIfIdle(run);
      this.save(run);
    }
  }

  /** Starts flows whose schedule is due; a run missed while Lattiz was closed happens once (§11.3). */
  tick(): void {
    const now = this.now();
    for (const f of this.d.store.liveFlows()) {
      if (!f.scheduleJson || f.nextRunAt === null || f.nextRunAt > now) continue;
      const schedule = JSON.parse(f.scheduleJson) as FlowSchedule;
      this.d.store.updateFlow(f.id, { nextRunAt: nextRun(schedule, now) });
      if (this.active(f.id)) continue; // still running from last time
      try {
        this.start(f.id, undefined, "schedule");
        if (now - f.nextRunAt > LATE_MS) {
          const run = this.active(f.id);
          if (run) {
            this.log(run, `It was due ${new Date(f.nextRunAt).toLocaleString()}, while Lattiz was closed.`);
            this.save(run);
          }
        }
      } catch (err) {
        console.warn(`[flows] scheduled run of ${f.name} failed to start`, err);
      }
      this.d.changed(f.id);
    }
  }
}
