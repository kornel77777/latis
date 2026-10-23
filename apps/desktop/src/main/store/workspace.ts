import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import {
  AgentEvent,
  AttentionKind,
  ChatStatus,
  Viewport,
  type AttentionItem,
  type CanvasNode,
  type CanvasState,
  type ChatSummary,
  type NodeGeometry,
  type PermissionMode,
  type Project,
  type StoredEvent,
  type Transcript,
  type Turn,
} from "@latis/shared";
import type { Db } from "./db";
import { attention, canvases, chats, events, nodes, projects, settings, turns } from "./schema";

const DEFAULT_CANVAS = "main";
const PROJECT_COLORS = ["teal", "indigo", "amber", "pink", "green", "sky"];
export const CHAT_SIZE = { w: 460, h: 600 };
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
      chats: chatRows.map((r) => toChatSummary(r, projectOf.get(r.nodeId) ?? null)),
      projects: projectRows.map((p) => toProject(p, frames.find((f) => f.projectId === p.id)!.id)),
    };
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
          title: input.title,
          createdAt: now,
          lastActivityAt: now,
        })
        .returning()
        .get();
      return { node: toCanvasNode(node), chat: toChatSummary(chat, input.projectId) };
    });
  }

  getChat(chatId: string): ChatSummary | undefined {
    const row = this.db.select().from(chats).where(eq(chats.id, chatId)).get();
    if (!row) return undefined;
    const node = this.db.select({ projectId: nodes.projectId }).from(nodes).where(eq(nodes.id, row.nodeId)).get();
    return toChatSummary(row, node?.projectId ?? null);
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
      .where(isNull(attention.resolvedAt))
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

function toChatSummary(r: typeof chats.$inferSelect, projectId: string | null): ChatSummary {
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
    cwd: r.cwd,
    title: r.title,
    status: status.success ? status.data : "idle",
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
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
