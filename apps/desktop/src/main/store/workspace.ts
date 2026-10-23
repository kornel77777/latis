import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { and, asc, desc, eq, inArray, isNotNull, isNull, max } from "drizzle-orm";
import {
  AgentEvent,
  AttentionKind,
  EdgeMode,
  type FlowEdge,
  type FlowInfo,
  type FlowRunInfo,
  type FlowSchedule,
  ChatStatus,
  Viewport,
  type AttentionItem,
  type CanvasNode,
  type CanvasState,
  type ChatSummary,
  type NodeGeometry,
  type PermissionMode,
  type Project,
  type ReviewDecisions,
  type ReviewItem,
  type ScheduledMessage,
  type FileStat,
  type StoredEvent,
  type Transcript,
  type Turn,
} from "@latis/shared";
import type { Db } from "./db";
import {
  attention,
  canvases,
  chats,
  checkpoints,
  events,
  mcpServers,
  nodes,
  projects,
  reviews,
  scheduled,
  flows,
  edges,
  flowRuns,
  settings,
  turns,
  worktrees,
} from "./schema";

const DEFAULT_CANVAS = "main";
const PROJECT_COLORS = ["teal", "indigo", "amber", "pink", "green", "sky"];
export const CHAT_SIZE = { w: 460, h: 600 };
export const NOTE_SIZE = { w: 340, h: 260 };
export const FRAME_PAD = { x: 24, top: 56 };

export interface ChatOptionsPatch {
  status?: ChatStatus;
  title?: string;
  titleLocked?: boolean;
  nativeSessionId?: string | null;
  model?: string | null;
  reasoning?: string | null;
  permissionMode?: PermissionMode;
}

export class WorkspaceStore {
  constructor(readonly db: Db) {}

  ensureDefaultCanvas(): string {
    this.db.insert(canvases).values({ id: DEFAULT_CANVAS, name: "Main canvas" }).onConflictDoNothing().run();
    return DEFAULT_CANVAS;
  }

  loadCanvas(canvasId: string): CanvasState {
    const c = this.db.select().from(canvases).where(eq(canvases.id, canvasId)).get();
    if (!c) throw new Error(`no canvas ${canvasId}`);
    const nodeRows = this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.canvasId, canvasId), isNull(nodes.deletedAt)))
      .orderBy(asc(nodes.z), asc(nodes.createdAt))
      .all();
    const nodeIds = nodeRows.map((n) => n.id);
    const chatRows = nodeIds.length ? this.db.select().from(chats).where(inArray(chats.nodeId, nodeIds)).all() : [];
    const projectOf = new Map(nodeRows.map((n) => [n.id, n.projectId]));
    const wtIds = chatRows.flatMap((r) => (r.worktreeId ? [r.worktreeId] : []));
    const wtOf = new Map(
      (wtIds.length ? this.db.select().from(worktrees).where(inArray(worktrees.id, wtIds)).all() : []).map((w) => [w.id, w]),
    );
    const frames = nodeRows.filter((n) => n.type === "frame" && n.projectId);
    const projectRows = frames.length
      ? this.db
          .select()
          .from(projects)
          .where(
            and(
              inArray(
                projects.id,
                frames.map((f) => f.projectId!),
              ),
              isNull(projects.archivedAt),
            ),
          )
          .all()
      : [];
    const vp = c.viewportJson ? Viewport.safeParse(JSON.parse(c.viewportJson)) : null;
    return {
      id: c.id,
      name: c.name,
      viewport: vp?.success ? vp.data : null,
      nodes: nodeRows.map(toCanvasNode),
      chats: chatRows.map((r) => toChatSummary(r, projectOf.get(r.nodeId) ?? null, wtOf.get(r.worktreeId ?? ""))),
      projects: projectRows.map((p) => toProject(p, frames.find((f) => f.projectId === p.id)!.id)),
      ...this.flowsOn(nodeRows.filter((n) => n.type === "flow").map((n) => n.id)),
    };
  }

  // ── Flows (§11) ────────────────────────────────────────────────────────────

  private flowsOn(frameIds: string[]): { flows: FlowInfo[]; edges: FlowEdge[] } {
    if (!frameIds.length) return { flows: [], edges: [] };
    const rows = this.db.select().from(flows).where(inArray(flows.nodeId, frameIds)).all();
    return { flows: rows.map((r) => this.flowInfoOf(r)), edges: rows.flatMap((r) => this.edgesOf(r.id)) };
  }

  private flowInfoOf(r: typeof flows.$inferSelect): FlowInfo {
    const run = this.latestRun(r.id);
    return {
      id: r.id,
      nodeId: r.nodeId,
      name: r.name,
      brief: r.brief,
      schedule: r.scheduleJson ? (JSON.parse(r.scheduleJson) as FlowSchedule) : null,
      nextRunAt: r.nextRunAt,
      loopLimit: r.loopLimit,
      run: run ? runInfo(run) : null,
    };
  }

  flowInfo(flowId: string): FlowInfo | undefined {
    const r = this.flowRow(flowId);
    return r && this.flowInfoOf(r);
  }

  flowRow(flowId: string): typeof flows.$inferSelect | undefined {
    return this.db.select().from(flows).where(eq(flows.id, flowId)).get();
  }

  flowByNode(nodeId: string): typeof flows.$inferSelect | undefined {
    return this.db.select().from(flows).where(eq(flows.nodeId, nodeId)).get();
  }

  /** Flows whose frame isn't deleted. */
  liveFlows(): (typeof flows.$inferSelect)[] {
    return this.db
      .select({ f: flows })
      .from(flows)
      .innerJoin(nodes, eq(nodes.id, flows.nodeId))
      .where(isNull(nodes.deletedAt))
      .all()
      .map((r) => r.f);
  }

  insertFlow(row: typeof flows.$inferInsert): void {
    this.db.insert(flows).values(row).run();
  }

  updateFlow(flowId: string, patch: Partial<Omit<typeof flows.$inferInsert, "id">>): void {
    this.db.update(flows).set(patch).where(eq(flows.id, flowId)).run();
  }

  edgesOf(flowId: string): FlowEdge[] {
    return this.db
      .select()
      .from(edges)
      .where(eq(edges.flowId, flowId))
      .all()
      .map((e) => ({ ...e, mode: EdgeMode.parse(e.mode) }));
  }

  addEdge(e: Omit<FlowEdge, "id">): FlowEdge {
    const row = { id: randomUUID(), ...e };
    this.db.insert(edges).values(row).run();
    return row;
  }

  edge(id: string): FlowEdge | undefined {
    const e = this.db.select().from(edges).where(eq(edges.id, id)).get();
    return e && { ...e, mode: EdgeMode.parse(e.mode) };
  }

  setEdgeMode(id: string, mode: EdgeMode): void {
    this.db.update(edges).set({ mode }).where(eq(edges.id, id)).run();
  }

  removeEdge(id: string): void {
    this.db.delete(edges).where(eq(edges.id, id)).run();
  }

  latestRun(flowId: string): typeof flowRuns.$inferSelect | undefined {
    return this.db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)).orderBy(desc(flowRuns.startedAt)).limit(1).get();
  }

  run(runId: string): typeof flowRuns.$inferSelect | undefined {
    return this.db.select().from(flowRuns).where(eq(flowRuns.id, runId)).get();
  }

  runsWithStatus(status: string[]): (typeof flowRuns.$inferSelect)[] {
    return this.db.select().from(flowRuns).where(inArray(flowRuns.status, status)).all();
  }

  insertRun(row: typeof flowRuns.$inferInsert): void {
    this.db.insert(flowRuns).values(row).run();
  }

  saveRun(runId: string, patch: Partial<Omit<typeof flowRuns.$inferInsert, "id">>): void {
    this.db.update(flowRuns).set(patch).where(eq(flowRuns.id, runId)).run();
  }

  saveNodeGeometry(list: NodeGeometry[]): void {
    this.db.transaction((tx) => {
      for (const n of list) {
        tx.update(nodes).set({ x: n.x, y: n.y, w: n.w, h: n.h, z: n.z }).where(eq(nodes.id, n.id)).run();
      }
    });
  }

  saveViewport(canvasId: string, viewport: Viewport): void {
    this.db
      .update(canvases)
      .set({ viewportJson: JSON.stringify(viewport) })
      .where(eq(canvases.id, canvasId))
      .run();
  }

  /** Creates a project for a folder and its frame node on the canvas. */
  createProject(input: { canvasId: string; folderPath: string; x: number; y: number }): { project: Project; node: CanvasNode } {
    const now = Date.now();
    const count = this.db.select({ n: projects.id }).from(projects).all().length;
    const id = randomUUID();
    const nodeId = randomUUID();
    return this.db.transaction((tx) => {
      const p = tx
        .insert(projects)
        .values({
          id,
          name: basename(input.folderPath) || input.folderPath,
          color: PROJECT_COLORS[count % PROJECT_COLORS.length]!,
          folderPath: input.folderPath,
          createdAt: now,
        })
        .returning()
        .get();
      const node = tx
        .insert(nodes)
        .values({
          id: nodeId,
          canvasId: input.canvasId,
          projectId: id,
          type: "frame",
          x: input.x,
          y: input.y,
          w: CHAT_SIZE.w * 2 + FRAME_PAD.x * 3,
          h: CHAT_SIZE.h + FRAME_PAD.top + FRAME_PAD.x,
          z: -1,
          dataJson: JSON.stringify({ projectId: id }),
          createdAt: now,
        })
        .returning()
        .get();
      return { project: toProject(p, nodeId), node: toCanvasNode(node) };
    });
  }

  getProject(projectId: string): Project | undefined {
    const p = this.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) return undefined;
    const frame = this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.projectId, projectId), eq(nodes.type, "frame")))
      .get();
    return frame ? toProject(p, frame.id) : undefined;
  }

  findProjectByFolder(folderPath: string): Project | undefined {
    const p = this.db
      .select()
      .from(projects)
      .where(and(eq(projects.folderPath, folderPath), isNull(projects.archivedAt)))
      .get();
    return p ? this.getProject(p.id) : undefined;
  }

  /** Children of a frame, for placing new chats in the first free slot. */
  frameChildren(frameNodeId: string): CanvasNode[] {
    return this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.parentId, frameNodeId), isNull(nodes.deletedAt)))
      .all()
      .map(toCanvasNode);
  }

  /**
   * First free grid slot (two columns) inside a project frame. Grows the frame
   * when the slot doesn't fit and returns its new geometry.
   */
  placeInFrame(frameNodeId: string): { x: number; y: number; frame: NodeGeometry | null } {
    const frame = this.db.select().from(nodes).where(eq(nodes.id, frameNodeId)).get();
    if (!frame) throw new Error(`no frame ${frameNodeId}`);
    const children = this.frameChildren(frameNodeId);
    const overlaps = (x: number, y: number) =>
      children.some((c) => x < c.x + c.w && x + CHAT_SIZE.w > c.x && y < c.y + c.h && y + CHAT_SIZE.h > c.y);
    let slot = { x: FRAME_PAD.x, y: FRAME_PAD.top };
    for (let i = 0; i < 200; i++) {
      const x = FRAME_PAD.x + (i % 2) * (CHAT_SIZE.w + FRAME_PAD.x);
      const y = FRAME_PAD.top + Math.floor(i / 2) * (CHAT_SIZE.h + FRAME_PAD.x);
      if (!overlaps(x, y)) {
        slot = { x, y };
        break;
      }
    }
    const w = Math.max(frame.w, slot.x + CHAT_SIZE.w + FRAME_PAD.x);
    const h = Math.max(frame.h, slot.y + CHAT_SIZE.h + FRAME_PAD.x);
    if (w === frame.w && h === frame.h) return { ...slot, frame: null };
    this.db.update(nodes).set({ w, h }).where(eq(nodes.id, frameNodeId)).run();
    return { ...slot, frame: { id: frame.id, x: frame.x, y: frame.y, w, h, z: frame.z } };
  }

  createChatNode(input: {
    canvasId: string;
    projectId: string | null;
    parentId: string | null;
    x: number;
    y: number;
    agentId: string;
    model: string | null;
    reasoning: string | null;
    permissionMode: PermissionMode;
    cwd: string;
    title: string;
    worktreeId?: string | null;
    role?: "conductor" | null;
    spawnedBy?: string | null;
    workspaceTools?: boolean;
    continuedFrom?: string | null;
  }): { node: CanvasNode; chat: ChatSummary } {
    const now = Date.now();
    const nodeId = randomUUID();
    const chatId = randomUUID();
    return this.db.transaction((tx) => {
      const node = tx
        .insert(nodes)
        .values({
          id: nodeId,
          canvasId: input.canvasId,
          projectId: input.projectId,
          parentId: input.parentId,
          type: "chat",
          x: input.x,
          y: input.y,
          w: CHAT_SIZE.w,
          h: CHAT_SIZE.h,
          dataJson: JSON.stringify({ chatId }),
          createdAt: now,
        })
        .returning()
        .get();
      const chat = tx
        .insert(chats)
        .values({
          id: chatId,
          nodeId,
          agentId: input.agentId,
          model: input.model,
          reasoning: input.reasoning,
          permissionMode: input.permissionMode,
          cwd: input.cwd,
          worktreeId: input.worktreeId ?? null,
          title: input.title,
          createdAt: now,
          lastActivityAt: now,
          role: input.role ?? null,
          spawnedBy: input.spawnedBy ?? null,
          workspaceTools: input.workspaceTools ?? false,
          continuedFrom: input.continuedFrom ?? null,
        })
        .returning()
        .get();
      const wt = chat.worktreeId ? tx.select().from(worktrees).where(eq(worktrees.id, chat.worktreeId)).get() : undefined;
      return { node: toCanvasNode(node), chat: toChatSummary(chat, input.projectId, wt) };
    });
  }

  getChat(chatId: string): ChatSummary | undefined {
    const row = this.db.select().from(chats).where(eq(chats.id, chatId)).get();
    if (!row) return undefined;
    const node = this.db.select({ projectId: nodes.projectId }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
    const wt = row.worktreeId ? this.getWorktree(row.worktreeId) : undefined;
    return toChatSummary(row, node?.projectId ?? null, wt);
  }

  /** The agent's own conversation id, for resume. Main-process only; never sent to the renderer. */
  nativeSessionId(chatId: string): string | null {
    return this.db.select({ id: chats.nativeSessionId }).from(chats).where(eq(chats.id, chatId)).get()?.id ?? null;
  }

  isTitleLocked(chatId: string): boolean {
    return this.db.select({ l: chats.titleLocked }).from(chats).where(eq(chats.id, chatId)).get()?.l ?? false;
  }

  updateChat(chatId: string, patch: ChatOptionsPatch): void {
    this.db
      .update(chats)
      .set({ ...patch, lastActivityAt: Date.now() })
      .where(eq(chats.id, chatId))
      .run();
  }

  /** Orchestration settings (§10): workspace tools, attached connections, the Conductor's agent. */
  setChatFlags(
    chatId: string,
    patch: { workspaceTools?: boolean; connections?: string[]; agentId?: string; model?: string | null; reasoning?: string | null },
  ): void {
    const { connections, ...rest } = patch;
    this.db
      .update(chats)
      .set({ ...rest, ...(connections && { connectionsJson: JSON.stringify(connections) }) })
      .where(eq(chats.id, chatId))
      .run();
  }

  /** The Conductor chat, if it exists and isn't deleted. */
  conductor(): ChatSummary | undefined {
    const row = this.db
      .select({ id: chats.id })
      .from(chats)
      .innerJoin(nodes, eq(nodes.id, chats.nodeId))
      .where(and(eq(chats.role, "conductor"), isNull(nodes.deletedAt)))
      .get();
    return row && this.getChat(row.id);
  }

  /** Chats (not deleted), for the workspace tools. */
  liveChats(): ChatSummary[] {
    const rows = this.db
      .select({ id: chats.id })
      .from(chats)
      .innerJoin(nodes, eq(nodes.id, chats.nodeId))
      .where(isNull(nodes.deletedAt))
      .orderBy(asc(chats.createdAt))
      .all();
    return rows.flatMap((r) => this.getChat(r.id) ?? []);
  }

  /** A node's position on the canvas (children of frames are stored relative to them). */
  absoluteRect(nodeId: string): { x: number; y: number; w: number; h: number } | undefined {
    const n = this.getNode(nodeId);
    if (!n) return undefined;
    const parent = n.parentId ? this.absoluteRect(n.parentId) : undefined;
    return { x: n.x + (parent?.x ?? 0), y: n.y + (parent?.y ?? 0), w: n.w, h: n.h };
  }

  listProjects(): Project[] {
    const rows = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(isNull(projects.archivedAt))
      .orderBy(asc(projects.createdAt))
      .all();
    return rows.flatMap((r) => this.getProject(r.id) ?? []);
  }

  // ── Send later (§9.10) ─────────────────────────────────────────────────────

  scheduledAll(): ScheduledMessage[] {
    return this.db
      .select()
      .from(scheduled)
      .orderBy(asc(scheduled.fireAt))
      .all()
      .map((r) => ({ id: r.id, chatId: r.chatId, text: r.text, fireAt: r.fireAt, repeatMs: r.repeatMs, onReset: r.onReset }));
  }

  addScheduled(input: Omit<ScheduledMessage, "id">): ScheduledMessage {
    const row = { id: randomUUID(), ...input, createdAt: Date.now() };
    this.db.insert(scheduled).values(row).run();
    return { id: row.id, ...input };
  }

  rescheduled(id: string, fireAt: number): void {
    this.db.update(scheduled).set({ fireAt }).where(eq(scheduled.id, id)).run();
  }

  removeScheduled(id: string): boolean {
    return this.db.delete(scheduled).where(eq(scheduled.id, id)).run().changes > 0;
  }

  // ── MCP connections (§9.15) ────────────────────────────────────────────────

  mcpRows(): (typeof mcpServers.$inferSelect)[] {
    return this.db.select().from(mcpServers).orderBy(asc(mcpServers.createdAt)).all();
  }

  mcpRow(id: string): typeof mcpServers.$inferSelect | undefined {
    return this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  }

  saveMcpRow(row: Omit<typeof mcpServers.$inferInsert, "createdAt"> & { createdAt?: number }): typeof mcpServers.$inferSelect {
    const full = { ...row, createdAt: row.createdAt ?? Date.now() };
    return this.db
      .insert(mcpServers)
      .values(full)
      .onConflictDoUpdate({ target: mcpServers.id, set: { ...full, createdAt: undefined } })
      .returning()
      .get();
  }

  removeMcpRow(id: string): void {
    this.db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  }

  createTurn(chatId: string, userText: string): Turn {
    const last = this.db
      .select({ seq: max(turns.seq) })
      .from(turns)
      .where(eq(turns.chatId, chatId))
      .get();
    const row = this.db
      .insert(turns)
      .values({ id: randomUUID(), chatId, seq: (last?.seq ?? -1) + 1, userText, startedAt: Date.now() })
      .returning()
      .get();
    this.index("user", row.id, chatId, userText);
    return toTurn(row);
  }

  endTurn(turnId: string, status: string): void {
    this.db.update(turns).set({ endedAt: Date.now(), status }).where(eq(turns.id, turnId)).run();
  }

  transcript(chatId: string): Transcript {
    const t = this.db.select().from(turns).where(eq(turns.chatId, chatId)).orderBy(asc(turns.seq)).all();
    const e = this.db.select().from(events).where(eq(events.chatId, chatId)).orderBy(asc(events.seq)).all();
    return { turns: t.map(toTurn), events: e.flatMap(toStoredEvent) };
  }

  maxEventSeq(chatId: string): number {
    return (
      this.db
        .select({ seq: max(events.seq) })
        .from(events)
        .where(eq(events.chatId, chatId))
        .get()?.seq ?? -1
    );
  }

  insertEvents(list: StoredEvent[]): void {
    if (!list.length) return;
    this.db.transaction((tx) => {
      for (const se of list) {
        tx.insert(events)
          .values({
            chatId: se.chatId,
            seq: se.seq,
            ts: se.ts,
            turnId: se.turnId,
            type: se.event.type,
            payloadJson: JSON.stringify(se.event),
          })
          .run();
        if (se.event.type === "message.completed") this.index("message", `${se.chatId}:${se.seq}`, se.chatId, se.event.text);
      }
    });
  }

  addAttention(input: { chatId: string; kind: AttentionKind; refId: string | null; summary: string; detail?: string }): AttentionItem {
    const item: AttentionItem = { id: randomUUID(), createdAt: Date.now(), ...input };
    this.db
      .insert(attention)
      .values({
        id: item.id,
        chatId: item.chatId,
        kind: item.kind,
        refId: item.refId,
        dataJson: JSON.stringify({ summary: item.summary, ...(item.detail !== undefined && { detail: item.detail }) }),
        createdAt: item.createdAt,
      })
      .run();
    return item;
  }

  /** Resolves a chat's open items, optionally only one request or some kinds. Returns how many closed. */
  resolveAttention(chatId: string, filter: { refId?: string; kinds?: AttentionKind[] } = {}): number {
    const conds = [eq(attention.chatId, chatId), isNull(attention.resolvedAt)];
    if (filter.refId !== undefined) conds.push(eq(attention.refId, filter.refId));
    if (filter.kinds) conds.push(inArray(attention.kind, filter.kinds));
    return this.db
      .update(attention)
      .set({ resolvedAt: Date.now() })
      .where(and(...conds))
      .run().changes;
  }

  dismissAttention(id: string): boolean {
    return (
      this.db
        .update(attention)
        .set({ resolvedAt: Date.now() })
        .where(and(eq(attention.id, id), isNull(attention.resolvedAt)))
        .run().changes > 0
    );
  }

  /** Open items, newest first. Items of deleted chats are skipped. */
  openAttention(): AttentionItem[] {
    const rows = this.db
      .select()
      .from(attention)
      .innerJoin(chats, eq(chats.id, attention.chatId))
      .innerJoin(nodes, eq(nodes.id, chats.nodeId))
      .where(and(isNull(attention.resolvedAt), isNull(nodes.deletedAt)))
      .orderBy(desc(attention.createdAt))
      .all();
    return rows.flatMap(({ attention: r }) => {
      const kind = AttentionKind.safeParse(r.kind);
      if (!kind.success) return [];
      const data = JSON.parse(r.dataJson) as { summary?: string; detail?: string };
      return [
        {
          id: r.id,
          chatId: r.chatId,
          kind: kind.data,
          refId: r.refId,
          summary: data.summary ?? "",
          ...(data.detail !== undefined && { detail: data.detail }),
          createdAt: r.createdAt,
        },
      ];
    });
  }

  // ── Notes, soft delete, projects (M4) ──────────────────────────────────────

  createNote(input: {
    canvasId: string;
    projectId: string | null;
    parentId: string | null;
    x: number;
    y: number;
    text?: string;
  }): CanvasNode {
    const row = this.db
      .insert(nodes)
      .values({
        id: randomUUID(),
        canvasId: input.canvasId,
        projectId: input.projectId,
        parentId: input.parentId,
        type: "note",
        x: input.x,
        y: input.y,
        w: NOTE_SIZE.w,
        h: NOTE_SIZE.h,
        dataJson: JSON.stringify({ text: input.text ?? "" }),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    if (input.text) this.index("note", row.id, null, input.text);
    return toCanvasNode(row);
  }

  /** A plain node (flow frames, Start nodes). */
  createNode(input: {
    canvasId: string;
    parentId: string | null;
    type: CanvasNode["type"];
    x: number;
    y: number;
    w: number;
    h: number;
    data: Record<string, unknown>;
  }): CanvasNode {
    const row = this.db
      .insert(nodes)
      .values({
        id: randomUUID(),
        canvasId: input.canvasId,
        projectId: null,
        parentId: input.parentId,
        type: input.type,
        x: input.x,
        y: input.y,
        w: input.w,
        h: input.h,
        dataJson: JSON.stringify(input.data),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return toCanvasNode(row);
  }

  getNode(nodeId: string): CanvasNode | undefined {
    const row = this.db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    return row && toCanvasNode(row);
  }

  /** Merges into a node's data (note text, etc.). */
  updateNodeData(nodeId: string, patch: Record<string, unknown>): void {
    const node = this.getNode(nodeId);
    if (!node) throw new Error("That item no longer exists.");
    this.db
      .update(nodes)
      .set({ dataJson: JSON.stringify({ ...node.data, ...patch }) })
      .where(eq(nodes.id, nodeId))
      .run();
    if (node.type === "note" && typeof patch.text === "string") {
      this.db.$client.prepare("DELETE FROM search WHERE kind = 'note' AND ref = ?").run(nodeId);
      this.index("note", nodeId, null, patch.text);
    }
  }

  private index(kind: "user" | "message" | "note", ref: string, chatId: string | null, body: string): void {
    if (body.trim())
      this.db.$client.prepare("INSERT INTO search (kind, ref, chat_id, body) VALUES (?, ?, ?, ?)").run(kind, ref, chatId, body);
  }

  /**
   * Full-text search (§9.16) over user messages, agent replies and notes, best matches first.
   * Items on deleted nodes are left out.
   */
  search(
    query: string,
    limit = 30,
  ): { kind: "user" | "message" | "note"; chatId: string | null; nodeId: string | null; snippet: string }[] {
    // Each word is a prefix term, quoted so FTS syntax in the query can't break it.
    const terms = query
      .split(/\s+/)
      .map((w) => w.replace(/"/g, ""))
      .filter(Boolean)
      .map((w) => `"${w}"*`);
    if (!terms.length) return [];
    const rows = this.db.$client
      .prepare(
        `SELECT s.kind, s.ref, s.chat_id AS chatId, snippet(search, 3, '[', ']', '…', 12) AS snippet,
                COALESCE(cn.id, s.ref) AS nodeId
           FROM search s
           LEFT JOIN chats c ON c.id = s.chat_id
           LEFT JOIN nodes cn ON cn.id = c.node_id
           LEFT JOIN nodes nn ON s.kind = 'note' AND nn.id = s.ref
          WHERE search MATCH ?
            AND (cn.id IS NULL OR cn.deleted_at IS NULL)
            AND (s.kind != 'note' OR (nn.id IS NOT NULL AND nn.deleted_at IS NULL))
          ORDER BY bm25(search)
          LIMIT ?`,
      )
      .all(terms.join(" "), limit) as {
      kind: "user" | "message" | "note";
      chatId: string | null;
      nodeId: string | null;
      snippet: string;
    }[];
    return rows.map((r) => ({ kind: r.kind, chatId: r.chatId, nodeId: r.nodeId, snippet: r.snippet }));
  }

  /**
   * Soft-deletes nodes (a frame takes its contents and its project with it). Files on disk are
   * never touched (§9.1 AC3). Returns every node id deleted, for undo/restore.
   */
  softDelete(nodeIds: string[]): string[] {
    const now = Date.now();
    // The Conductor is pinned and can't be deleted (§10.2).
    const pinned = this.conductor()?.nodeId;
    nodeIds = nodeIds.filter((id) => id !== pinned);
    return this.db.transaction((tx) => {
      const ids = new Set(nodeIds);
      for (const id of nodeIds) {
        for (const child of tx
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(eq(nodes.parentId, id), isNull(nodes.deletedAt)))
          .all())
          ids.add(child.id);
      }
      const list = [...ids];
      if (!list.length) return [];
      const rows = tx.select().from(nodes).where(inArray(nodes.id, list)).all();
      tx.update(nodes).set({ deletedAt: now }).where(inArray(nodes.id, list)).run();
      for (const r of rows)
        if (r.type === "frame" && r.projectId) tx.update(projects).set({ archivedAt: now }).where(eq(projects.id, r.projectId)).run();
      return list;
    });
  }

  restore(nodeIds: string[]): void {
    this.db.transaction((tx) => {
      const rows = tx.select().from(nodes).where(inArray(nodes.id, nodeIds)).all();
      tx.update(nodes).set({ deletedAt: null }).where(inArray(nodes.id, nodeIds)).run();
      for (const r of rows)
        if (r.type === "frame" && r.projectId) tx.update(projects).set({ archivedAt: null }).where(eq(projects.id, r.projectId)).run();
    });
  }

  /** Deleted top-level items from the last 7 days, newest first (§7.2 restore). */
  deletedItems(canvasId: string): { nodeIds: string[]; type: string; title: string; deletedAt: number }[] {
    const since = Date.now() - 7 * 24 * 3600 * 1000;
    const rows = this.db
      .select()
      .from(nodes)
      .where(and(eq(nodes.canvasId, canvasId), isNotNull(nodes.deletedAt)))
      .orderBy(desc(nodes.deletedAt))
      .all()
      .filter((r) => r.deletedAt! >= since);
    // Group by deletion moment: a deleted frame and its contents restore together.
    const groups = new Map<number, typeof rows>();
    for (const r of rows) groups.set(r.deletedAt!, [...(groups.get(r.deletedAt!) ?? []), r]);
    return [...groups.values()].map((g) => {
      const head = g.find((r) => !g.some((o) => o.id === r.parentId)) ?? g[0]!;
      return { nodeIds: g.map((r) => r.id), type: head.type, title: this.nodeTitle(head), deletedAt: head.deletedAt! };
    });
  }

  private nodeTitle(r: typeof nodes.$inferSelect): string {
    const data = JSON.parse(r.dataJson) as { chatId?: string; projectId?: string; text?: string };
    if (r.type === "chat" && data.chatId)
      return this.db.select({ t: chats.title }).from(chats).where(eq(chats.id, data.chatId)).get()?.t ?? "Chat";
    if (r.type === "frame" && data.projectId)
      return this.db.select({ n: projects.name }).from(projects).where(eq(projects.id, data.projectId)).get()?.n ?? "Project";
    if (r.type === "note")
      return (
        (data.text ?? "")
          .split("\n")
          .find((l) => l.trim())
          ?.replace(/^#+\s*/, "")
          .slice(0, 60) || "Untitled note"
      );
    return r.type;
  }

  updateProject(projectId: string, patch: { name?: string; color?: string; folderPath?: string }): Project {
    this.db.update(projects).set(patch).where(eq(projects.id, projectId)).run();
    const p = this.getProject(projectId);
    if (!p) throw new Error("That project no longer exists.");
    return p;
  }

  // ── Worktrees, checkpoints, reviews (M3) ───────────────────────────────────

  chatsInProject(projectId: string): number {
    return this.db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.projectId, projectId), eq(nodes.type, "chat"), isNull(nodes.deletedAt)))
      .all().length;
  }

  createWorktree(row: Omit<typeof worktrees.$inferInsert, "id" | "createdAt">): typeof worktrees.$inferSelect {
    return this.db
      .insert(worktrees)
      .values({ ...row, id: randomUUID(), createdAt: Date.now() })
      .returning()
      .get();
  }

  getWorktree(id: string): typeof worktrees.$inferSelect | undefined {
    return this.db.select().from(worktrees).where(eq(worktrees.id, id)).get();
  }

  updateWorktree(id: string, patch: Partial<Pick<typeof worktrees.$inferSelect, "mergedAt" | "removedAt">>): void {
    this.db.update(worktrees).set(patch).where(eq(worktrees.id, id)).run();
  }

  /** The chat's cwd moves when its worktree is removed (back to the project folder). */
  setChatCwd(chatId: string, cwd: string, worktreeId: string | null): void {
    this.db.update(chats).set({ cwd, worktreeId }).where(eq(chats.id, chatId)).run();
  }

  addCheckpoint(input: { chatId: string; turnId: string; repo: string; before: string }): void {
    this.db
      .insert(checkpoints)
      .values({ id: randomUUID(), createdAt: Date.now(), ...input })
      .run();
    this.db.update(turns).set({ checkpointBefore: input.before }).where(eq(turns.id, input.turnId)).run();
  }

  finishCheckpoint(turnId: string, after: string, files: string[]): void {
    this.db
      .update(checkpoints)
      .set({ after, filesJson: JSON.stringify(files) })
      .where(eq(checkpoints.turnId, turnId))
      .run();
    this.db.update(turns).set({ checkpointAfter: after }).where(eq(turns.id, turnId)).run();
  }

  checkpoint(turnId: string) {
    const r = this.db.select().from(checkpoints).where(eq(checkpoints.turnId, turnId)).get();
    return r && { ...r, files: JSON.parse(r.filesJson) as string[] };
  }

  chatCheckpoints(chatId: string) {
    return this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.chatId, chatId))
      .orderBy(asc(checkpoints.createdAt))
      .all()
      .map((r) => ({ ...r, files: JSON.parse(r.filesJson) as string[] }));
  }

  setUndone(turnId: string, undone: boolean): void {
    this.db
      .update(checkpoints)
      .set({ undoneAt: undone ? Date.now() : null })
      .where(eq(checkpoints.turnId, turnId))
      .run();
  }

  turns(chatId: string): Turn[] {
    return this.db.select().from(turns).where(eq(turns.chatId, chatId)).orderBy(asc(turns.seq)).all().map(toTurn);
  }

  addReview(input: { chatId: string; turnId: string; summary: string; files: FileStat[] }): ReviewItem {
    const row = this.db
      .insert(reviews)
      .values({
        id: randomUUID(),
        chatId: input.chatId,
        turnId: input.turnId,
        summary: input.summary,
        filesJson: JSON.stringify(input.files),
        createdAt: Date.now(),
      })
      .returning()
      .get();
    return toReview(row);
  }

  getReview(id: string): ReviewItem | undefined {
    const r = this.db.select().from(reviews).where(eq(reviews.id, id)).get();
    return r && toReview(r);
  }

  updateReview(id: string, patch: { decisions?: ReviewDecisions; reviewedAt?: number | null }): ReviewItem {
    this.db
      .update(reviews)
      .set({
        ...(patch.decisions && { decisionsJson: JSON.stringify(patch.decisions) }),
        ...(patch.reviewedAt !== undefined && { reviewedAt: patch.reviewedAt }),
      })
      .where(eq(reviews.id, id))
      .run();
    return this.getReview(id)!;
  }

  /** Open review items plus the 50 most recently reviewed, newest first, for chats that still exist. */
  listReviews(): ReviewItem[] {
    const rows = this.db
      .select()
      .from(reviews)
      .innerJoin(chats, eq(chats.id, reviews.chatId))
      .innerJoin(nodes, eq(nodes.id, chats.nodeId))
      .where(isNull(nodes.deletedAt))
      .orderBy(desc(reviews.createdAt))
      .all()
      .map((r) => toReview(r.reviews));
    return [...rows.filter((r) => r.reviewedAt === null), ...rows.filter((r) => r.reviewedAt !== null).slice(0, 50)];
  }

  getSetting<T>(key: string): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    return row ? (JSON.parse(row.valueJson) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    const valueJson = JSON.stringify(value);
    this.db.insert(settings).values({ key, valueJson }).onConflictDoUpdate({ target: settings.key, set: { valueJson } }).run();
  }
}

function toProject(r: typeof projects.$inferSelect, frameNodeId: string): Project {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    folderPath: r.folderPath,
    frameNodeId,
    folderMissing: !existsSync(r.folderPath),
    createdAt: r.createdAt,
  };
}

function toCanvasNode(r: typeof nodes.$inferSelect): CanvasNode {
  return {
    id: r.id,
    canvasId: r.canvasId,
    projectId: r.projectId,
    parentId: r.parentId,
    type: r.type as CanvasNode["type"],
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    z: r.z,
    data: JSON.parse(r.dataJson) as Record<string, unknown>,
  };
}

const MODES = new Set<string>(["read-only", "ask", "auto-edit", "full-auto"]);

function toReview(r: typeof reviews.$inferSelect): ReviewItem {
  return {
    id: r.id,
    chatId: r.chatId,
    turnId: r.turnId,
    summary: r.summary,
    files: JSON.parse(r.filesJson) as FileStat[],
    decisions: JSON.parse(r.decisionsJson) as ReviewDecisions,
    createdAt: r.createdAt,
    reviewedAt: r.reviewedAt,
  };
}

function toChatSummary(r: typeof chats.$inferSelect, projectId: string | null, wt?: typeof worktrees.$inferSelect): ChatSummary {
  const status = ChatStatus.safeParse(r.status);
  return {
    id: r.id,
    nodeId: r.nodeId,
    projectId,
    agentId: r.agentId,
    model: r.model,
    reasoning: r.reasoning,
    permissionMode: MODES.has(r.permissionMode) ? (r.permissionMode as PermissionMode) : "auto-edit",
    resumable: r.nativeSessionId !== null,
    worktree: wt
      ? { id: wt.id, branch: wt.branch, baseRef: wt.baseRef, path: wt.path, merged: wt.mergedAt !== null, removed: wt.removedAt !== null }
      : null,
    cwd: r.cwd,
    title: r.title,
    status: status.success ? status.data : "idle",
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    role: r.role === "conductor" ? "conductor" : null,
    workspaceTools: r.workspaceTools,
    spawnedBy: r.spawnedBy,
    connections: JSON.parse(r.connectionsJson) as string[],
    continuedFrom: r.continuedFrom,
  };
}

function toTurn(r: typeof turns.$inferSelect): Turn {
  return {
    id: r.id,
    chatId: r.chatId,
    seq: r.seq,
    userText: r.userText,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    status: r.status,
  };
}

function toStoredEvent(r: typeof events.$inferSelect): StoredEvent[] {
  const parsed = AgentEvent.safeParse(JSON.parse(r.payloadJson));
  if (!parsed.success) {
    console.warn(`[store] skipping unreadable event ${r.chatId}#${r.seq}`);
    return [];
  }
  return [{ chatId: r.chatId, seq: r.seq, ts: r.ts, turnId: r.turnId, event: parsed.data }];
}

/** The renderer's view of a run: its status, what waits on the user, and the log. */
function runInfo(r: {
  id: string;
  status: string;
  trigger: string;
  stateJson: string;
  logJson: string;
  startedAt: number;
  endedAt: number | null;
}): FlowRunInfo {
  const st = JSON.parse(r.stateJson) as {
    approvals?: { id: string; edgeId: string; item: { text: string; label: string }; to: string }[];
    loopCheck?: boolean;
    handoffs?: number;
  };
  return {
    id: r.id,
    status: r.status as FlowRunInfo["status"],
    trigger: r.trigger,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    approvals: (st.approvals ?? []).map((a) => ({ id: a.id, edgeId: a.edgeId, from: a.item.label, to: a.to, text: a.item.text })),
    loopCheck: Boolean(st.loopCheck),
    handoffs: st.handoffs ?? 0,
    log: (JSON.parse(r.logJson) as { at: number; text: string }[]).slice(-200),
  };
}
