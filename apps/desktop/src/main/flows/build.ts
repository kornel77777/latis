import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CanvasNode, ChatSummary, FlowEdge, FlowInfo, FlowSpec, PermissionMode } from "@lattiz/shared";
import { CHAT_SIZE, NOTE_SIZE, type WorkspaceStore } from "../store/workspace";
import { nextRun } from "./engine";

// Builds a flow from a spec (SPEC §11.5–11.6): a frame with its nodes laid out left to right in
// topological order, plus the edges.

const SIZE = { start: { w: 300, h: 220 }, chat: CHAT_SIZE, note: NOTE_SIZE, card: { w: 420, h: 360 } };
const PAD = { x: 32, top: 64, gap: 48 };

export interface BuildDeps {
  store: WorkspaceStore;
  dataDir: string;
  canvasId: string;
  /** Agents a flow chat can use, best first. */
  readyAgents(): Promise<string[]>;
  defaultMode(): PermissionMode;
  createCard(input: { title: string; gate: string; fields?: string[]; x: number; y: number; parentId: string }): CanvasNode;
}

/** Column per node: the longest path from a node with no inputs (cycles fall back to spec order). */
export function columns(spec: FlowSpec): Map<string, number> {
  const ids = spec.nodes.map((n) => n.id);
  const into = new Map(ids.map((id) => [id, spec.edges.filter((e) => e.to === id && e.from !== id).map((e) => e.from)]));
  const col = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (col.has(id)) return col.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = into.get(id) ?? [];
    const d = parents.length ? Math.max(...parents.map(depth)) + 1 : 0;
    visiting.delete(id);
    col.set(id, d);
    return d;
  };
  ids.forEach(depth);
  return col;
}

export function validate(spec: FlowSpec): void {
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) throw new Error(`Two nodes are called "${n.id}".`);
    ids.add(n.id);
  }
  for (const e of spec.edges)
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`The edge ${e.from} → ${e.to} points at a node that isn't in the flow.`);
  if (!spec.nodes.some((n) => n.type === "start")) throw new Error("A flow needs a Start node.");
}

export async function buildFlow(d: BuildDeps, spec: FlowSpec, x: number, y: number) {
  validate(spec);
  const flowId = randomUUID();
  const col = columns(spec);
  const cols = Math.max(...col.values()) + 1;
  const colW = [...Array(cols)].map((_, c) => Math.max(...spec.nodes.filter((n) => col.get(n.id) === c).map((n) => SIZE[n.type].w)));
  const colX = colW.map((_, c) => PAD.x + colW.slice(0, c).reduce((a, w) => a + w + PAD.gap, 0));
  const rowY = new Map<number, number>();
  const place = (id: string, type: keyof typeof SIZE) => {
    const c = col.get(id)!;
    const yy = rowY.get(c) ?? PAD.top;
    rowY.set(c, yy + SIZE[type].h + PAD.gap);
    return { x: colX[c]!, y: yy };
  };
  const positions = new Map(spec.nodes.map((n) => [n.id, place(n.id, n.type)]));
  const width = colX[cols - 1]! + colW[cols - 1]! + PAD.x;
  const height = Math.max(...rowY.values()) + PAD.x - PAD.gap;

  const frame = d.store.createNode({
    canvasId: d.canvasId,
    parentId: null,
    type: "flow",
    x,
    y,
    w: width,
    h: height,
    data: { flowId, name: spec.name },
  });
  d.store.insertFlow({
    id: flowId,
    nodeId: frame.id,
    name: spec.name,
    brief: spec.brief ?? "",
    scheduleJson: spec.schedule ? JSON.stringify(spec.schedule) : null,
    nextRunAt: spec.schedule ? nextRun(spec.schedule, Date.now()) : null,
    createdAt: Date.now(),
  });

  const cwd = spec.cwd ? resolve(spec.cwd.replace(/^~(?=$|[/\\])/, homedir())) : join(d.dataDir, "flows", flowId);
  mkdirSync(cwd, { recursive: true });
  const ready = await d.readyAgents();
  if (!ready.length && spec.nodes.some((n) => n.type === "chat")) throw new Error("No agent is ready. Set one up in Settings → Agents.");
  let rotate = 0;
  const agentFor = (wanted?: string) => {
    if (wanted && wanted !== "auto") {
      const w = wanted.toLowerCase();
      const hit = ready.find((a) => a === w || a.startsWith(w));
      if (hit) return hit;
    }
    return ready[rotate++ % ready.length]!;
  };

  const ids = new Map<string, string>();
  const created: CanvasNode[] = [frame];
  const chats: ChatSummary[] = [];
  for (const n of spec.nodes) {
    const at = positions.get(n.id)!;
    if (n.type === "start") {
      const node = d.store.createNode({
        canvasId: d.canvasId,
        parentId: frame.id,
        type: "start",
        x: at.x,
        y: at.y,
        w: SIZE.start.w,
        h: SIZE.start.h,
        data: { title: n.title ?? "Start", input: n.input ?? "", oneTaskPerLine: n.oneTaskPerLine ?? false },
      });
      ids.set(n.id, node.id);
      created.push(node);
    } else if (n.type === "chat") {
      const agentId = agentFor(n.agent);
      const { node, chat } = d.store.createChatNode({
        canvasId: d.canvasId,
        projectId: null,
        parentId: frame.id,
        x: at.x,
        y: at.y,
        agentId,
        model: agentId === "fake" ? "demo-1" : null,
        reasoning: null,
        permissionMode: spec.permissionMode ?? d.defaultMode(),
        cwd,
        title: n.title ?? "Chat",
      });
      d.store.updateChat(chat.id, { titleLocked: true });
      d.store.updateNodeData(node.id, { job: n.job ?? "" });
      ids.set(n.id, node.id);
      created.push(d.store.getNode(node.id)!);
      chats.push(d.store.getChat(chat.id)!);
    } else if (n.type === "note") {
      const node = d.store.createNote({
        canvasId: d.canvasId,
        projectId: null,
        parentId: frame.id,
        x: at.x,
        y: at.y,
        text: `# ${n.title ?? "Note"}\n`,
      });
      ids.set(n.id, node.id);
      created.push(node);
    } else {
      const node = d.createCard({
        title: n.title ?? "Results",
        gate: n.gate ?? "results",
        ...(n.fields && { fields: n.fields }),
        x: at.x,
        y: at.y,
        parentId: frame.id,
      });
      ids.set(n.id, node.id);
      created.push(node);
    }
  }
  const edges: FlowEdge[] = spec.edges.map((e) =>
    d.store.addEdge({ flowId, source: ids.get(e.from)!, target: ids.get(e.to)!, mode: e.mode ?? "every" }),
  );
  return { flow: d.store.flowInfo(flowId)! as FlowInfo, nodes: created, chats, edges };
}
