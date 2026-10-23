import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  buildTranscript,
  type CanvasNode,
  type ChatStatus,
  type ChatSummary,
  type FileDiff,
  type FlowInfo,
  type FlowSpec,
  type FocusView,
  type PermissionMode,
  type Project,
} from "@latis/shared";
import type { WorkspaceStore } from "../store/workspace";

// The workspace as tools (SPEC §10.1). The MCP server is a thin layer over this service, so the
// rules (placement, guardrails, digests) are testable without HTTP.

const MODE_ORDER: PermissionMode[] = ["read-only", "ask", "auto-edit", "full-auto"];
/** A tool result an agent can read without drowning: diffs and transcripts are capped. */
const DIFF_CAP = 60_000;
const MESSAGE_CAP = 6_000;
const ACTIVE: ChatStatus[] = ["working", "needs-you"];

export interface WorkspaceDeps {
  store: WorkspaceStore;
  canvasId: string;
  supervisor: {
    send(chatId: string, text: string): Promise<unknown>;
    steer(chatId: string, text: string): Promise<{ delivered: string }>;
    enqueue(chatId: string, text: string): Promise<"sent" | "queued">;
    lastMessageOf(chatId: string): string | undefined;
    busy(chatId: string): boolean;
    release(chatId: string): Promise<void>;
  };
  agents: {
    /** Agents a chat can be started with (installed, structured). */
    available(): Promise<{ id: string; displayName: string; signedIn: boolean }[]>;
  };
  changes: {
    createWorktree(projectId: string, folder: string, title: string): Promise<{ worktreeId: string; cwd: string }>;
    chatDiff(chatId: string): Promise<FileDiff[]>;
  };
  /** Opens a folder as a project (or finds it) near a canvas point. */
  openProject(folder: string, x: number, y: number): { project: Project; node: CanvasNode; existed: boolean };
  /** Asks the user in a dialog. */
  confirm(message: string, detail: string): Promise<boolean>;
  ui: {
    upsert(payload: { nodes: CanvasNode[]; chats: ChatSummary[]; projects: Project[]; reveal: string | null }): void;
    focus(view: FocusView): void;
    tidy(): void;
  };
  /** Max chats a caller may have running at once (§10.1 guardrails). */
  maxSpawned(): number;
  createFlow(spec: FlowSpec, x: number, y: number): Promise<FlowInfo>;
  startFlow(flowId: string, input?: string): void;
  cards: {
    create(input: { title: string; html: string; refreshScript?: string; x: number; y: number }): CanvasNode;
    update(id: string, patch: { html?: string; refreshScript?: string; title?: string }): CanvasNode;
  };
}

export class ToolError extends Error {}

export class WorkspaceService {
  constructor(private readonly d: WorkspaceDeps) {}

  private chat(chatId: string): ChatSummary {
    const c = this.d.store.getChat(chatId);
    const node = c && this.d.store.getNode(c.nodeId);
    if (!c || !node || this.isDeleted(c)) throw new ToolError(`No chat with id ${chatId}. Use list_chats to see the ids.`);
    return c;
  }

  private isDeleted(c: ChatSummary): boolean {
    return !this.d.store.liveChats().some((x) => x.id === c.id);
  }

  listProjects() {
    const chats = this.d.store.liveChats();
    return this.d.store.listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.folderPath,
      folder_missing: p.folderMissing,
      active_chats: chats.filter((c) => c.projectId === p.id && ACTIVE.includes(c.status)).length,
      chats: chats.filter((c) => c.projectId === p.id).length,
    }));
  }

  listChats(filter: { project_id?: string; status?: string }) {
    return this.d.store
      .liveChats()
      .filter((c) => (!filter.project_id || c.projectId === filter.project_id) && (!filter.status || c.status === filter.status))
      .map((c) => ({
        id: c.id,
        title: c.title,
        agent: c.agentId,
        model: c.model,
        cwd: c.cwd,
        branch: c.worktree && !c.worktree.removed ? c.worktree.branch : null,
        status: c.status,
        project_id: c.projectId,
        conductor: c.role === "conductor" || undefined,
        spawned_by: c.spawnedBy,
        last_activity: new Date(c.lastActivityAt).toISOString(),
      }));
  }

  /** Recent user/assistant messages and a one-line summary of each turn's steps. */
  readChat(chatId: string, lastTurns = 3): string {
    const c = this.chat(chatId);
    const t = this.d.store.transcript(chatId);
    const keep = new Set(t.turns.slice(-Math.max(1, lastTurns)).map((x) => x.id));
    const items = buildTranscript(
      t.turns.filter((x) => keep.has(x.id)),
      t.events.filter((e) => e.turnId && keep.has(e.turnId)),
    );
    const out: string[] = [`# ${c.title} (${c.agentId}, ${c.status})`, `cwd: ${c.cwd}`];
    let steps: string[] = [];
    const flushSteps = () => {
      if (!steps.length) return;
      const shown = steps.slice(0, 12);
      out.push(`[steps: ${shown.join("; ")}${steps.length > shown.length ? `; +${steps.length - shown.length} more` : ""}]`);
      steps = [];
    };
    for (const it of items) {
      if (it.kind === "step") {
        steps.push(it.paths.length ? `${it.name} ${it.paths.slice(0, 3).join(", ")}` : it.name);
        continue;
      }
      if (it.kind === "user") {
        flushSteps();
        out.push(`\n## User\n${cap(it.text, MESSAGE_CAP)}`);
      } else if (it.kind === "steer") out.push(`\n## User (mid-turn)\n${cap(it.text, MESSAGE_CAP)}`);
      else if (it.kind === "assistant" && it.text.trim()) {
        flushSteps();
        out.push(`\n## Assistant\n${cap(it.text, MESSAGE_CAP)}`);
      } else if (it.kind === "file") steps.push(`${it.change} ${it.path}`);
      else if (it.kind === "error") out.push(`\n[error: ${it.message}]`);
      else if (it.kind === "permission" && it.pending) out.push(`\n[waiting for the user to approve: ${it.summary}]`);
      else if ((it.kind === "question" || it.kind === "plan") && it.pending) out.push(`\n[waiting for the user to answer a ${it.kind}]`);
    }
    flushSteps();
    if (!t.turns.length) out.push("\n(no messages yet)");
    return out.join("\n");
  }

  private async resolveAgent(name: string): Promise<{ id: string; displayName: string }> {
    const list = await this.d.agents.available();
    const n = name.trim().toLowerCase();
    const hit =
      list.find((a) => a.id === n) ??
      list.find((a) => a.displayName.toLowerCase() === n) ??
      list.find((a) => a.id.startsWith(n) || a.displayName.toLowerCase().startsWith(n));
    if (!hit) throw new ToolError(`No agent called "${name}". Available: ${list.map((a) => a.id).join(", ") || "none"}.`);
    if (!hit.signedIn) throw new ToolError(`${hit.displayName} isn't signed in. Ask the user to sign in from Settings → Agents.`);
    return hit;
  }

  private placeNear(caller: ChatSummary | undefined): { x: number; y: number } {
    const r = caller && this.d.store.absoluteRect(caller.nodeId);
    return r ? { x: r.x + r.w + 80, y: r.y } : { x: 0, y: 0 };
  }

  async spawnChat(
    callerId: string,
    a: { agent: string; cwd: string; prompt: string; model?: string; own_copy?: boolean; title?: string; permission_mode?: PermissionMode },
  ) {
    const caller = this.d.store.getChat(callerId);
    const running = this.d.store.liveChats().filter((c) => c.spawnedBy === callerId && ACTIVE.includes(c.status)).length;
    if (running >= this.d.maxSpawned())
      throw new ToolError(
        `You already have ${running} chats running (the limit is ${this.d.maxSpawned()}). Wait for some to finish with wait_for_chats.`,
      );
    const agent = await this.resolveAgent(a.agent);
    const folder = resolve(a.cwd.replace(/^~(?=$|[/\\])/, homedir()));
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new ToolError(`${a.cwd} isn't a folder on this computer.`);
    // Spawned chats run with the caller's permission mode or a stricter one, never looser.
    const callerMode = caller?.permissionMode ?? "ask";
    const mode =
      a.permission_mode && MODE_ORDER.indexOf(a.permission_mode) < MODE_ORDER.indexOf(callerMode) ? a.permission_mode : callerMode;
    const near = this.placeNear(caller);
    const opened = this.d.openProject(folder, near.x, near.y);
    const project = opened.project;
    const own = a.own_copy ? await this.d.changes.createWorktree(project.id, project.folderPath, agent.displayName) : null;
    const place = this.d.store.placeInFrame(project.frameNodeId);
    const { node, chat } = this.d.store.createChatNode({
      canvasId: this.d.canvasId,
      projectId: project.id,
      parentId: project.frameNodeId,
      x: place.x,
      y: place.y,
      agentId: agent.id,
      model: a.model ?? null,
      reasoning: null,
      permissionMode: mode,
      cwd: own?.cwd ?? project.folderPath,
      worktreeId: own?.worktreeId ?? null,
      title: a.title?.trim() || "New chat",
      spawnedBy: callerId,
    });
    if (a.title?.trim()) this.d.store.updateChat(chat.id, { titleLocked: true });
    const frame = this.d.store.getNode(project.frameNodeId);
    this.d.ui.upsert({
      nodes: [...(frame ? [frame] : []), node],
      chats: [this.d.store.getChat(chat.id)!],
      projects: [this.d.store.getProject(project.id)!],
      reveal: null,
    });
    await this.d.supervisor.send(chat.id, a.prompt);
    const after = this.d.store.getChat(chat.id)!;
    return {
      chat_id: chat.id,
      title: after.title,
      agent: agent.id,
      cwd: after.cwd,
      branch: after.worktree?.branch ?? null,
      status: after.status,
      permission_mode: mode,
    };
  }

  async sendMessage(chatId: string, text: string, mode: "queue" | "now") {
    const c = this.chat(chatId);
    if (c.role === "conductor") throw new ToolError("That's the Conductor itself.");
    if (mode === "now") {
      const r = await this.d.supervisor.steer(chatId, text);
      return { delivered: r.delivered };
    }
    return { delivered: await this.d.supervisor.enqueue(chatId, text) };
  }

  /** Blocks until none of the chats is working; a chat that needs the user counts as stopped. */
  async waitForChats(ids: string[], timeoutS: number, signal?: AbortSignal) {
    ids.forEach((id) => this.chat(id));
    const deadline = Date.now() + timeoutS * 1000;
    const settled = () => ids.every((id) => this.chat(id).status !== "working" && !this.d.supervisor.busy(id));
    while (!settled() && Date.now() < deadline && !signal?.aborted) await sleep(500);
    const timedOut = !settled();
    return {
      timed_out: timedOut,
      chats: ids.map((id) => {
        const c = this.chat(id);
        const last = this.d.supervisor.lastMessageOf(id) ?? this.lastFromTranscript(id);
        return {
          id,
          title: c.title,
          status: c.status,
          ...(c.status === "needs-you" && { note: "Waiting for the user (an approval or a question). Ask the user to look at it." }),
          final_message: last ? cap(last, MESSAGE_CAP) : null,
        };
      }),
    };
  }

  private lastFromTranscript(chatId: string): string | undefined {
    const t = this.d.store.transcript(chatId);
    const items = buildTranscript(t.turns, t.events);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === "assistant" && it.text.trim()) return it.text;
      if (it.kind === "user") return undefined;
    }
    return undefined;
  }

  async getDiff(chatId: string): Promise<string> {
    const c = this.chat(chatId);
    const files = await this.d.changes.chatDiff(chatId);
    if (!files.length) return `${c.title} hasn't changed any files${c.worktree ? " on its branch" : ""}.`;
    const stat = files.map((f) => `${f.change.padEnd(8)} ${f.path}  +${f.additions} -${f.deletions}`).join("\n");
    let patch = "";
    for (const f of files) {
      if (f.binary) {
        patch += `\n--- ${f.path} (binary)\n`;
        continue;
      }
      patch += `\n--- a/${f.oldPath ?? f.path}\n+++ b/${f.path}\n`;
      for (const h of f.hunks) patch += `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}\n`;
      if (patch.length > DIFF_CAP) break;
    }
    const truncated = patch.length > DIFF_CAP;
    return `${files.length} file(s) changed\n${stat}\n${truncated ? patch.slice(0, DIFF_CAP) + "\n[patch truncated]" : patch}`;
  }

  createNote(callerId: string, title: string, markdown: string, nearChatId?: string) {
    const near = nearChatId ? this.chat(nearChatId) : this.d.store.getChat(callerId);
    const p = this.placeNear(near);
    // Notes from tools sit just below the chat they're about, so they don't cover other cards.
    const r = near && this.d.store.absoluteRect(near.nodeId);
    const node = this.d.store.createNote({
      canvasId: this.d.canvasId,
      projectId: null,
      parentId: null,
      x: r ? r.x : p.x,
      y: r ? r.y + r.h + 40 : p.y,
      text: `# ${title.trim()}\n\n${markdown.trim()}\n`,
    });
    this.d.ui.upsert({ nodes: [node], chats: [], projects: [], reveal: node.id });
    return { note_id: node.id };
  }

  appendNote(noteId: string, markdown: string) {
    const node = this.d.store.getNode(noteId);
    if (!node || node.type !== "note") throw new ToolError(`No note with id ${noteId}.`);
    const text = `${String(node.data.text ?? "").trimEnd()}\n\n${markdown.trim()}\n`;
    this.d.store.updateNodeData(noteId, { text });
    this.d.ui.upsert({ nodes: [this.d.store.getNode(noteId)!], chats: [], projects: [], reveal: null });
    return { note_id: noteId };
  }

  /** A flow from a spec (§11.6), placed to the right of the caller. */
  async createFlow(callerId: string, spec: FlowSpec) {
    const p = this.placeNear(this.d.store.getChat(callerId));
    try {
      const f = await this.d.createFlow(spec, p.x, p.y);
      return { flow_id: f.id, schedule: f.schedule, next_run: f.nextRunAt ? new Date(f.nextRunAt).toISOString() : null };
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
  }

  startFlow(flowId: string, input?: string) {
    try {
      this.d.startFlow(flowId, input);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    return { started: true };
  }

  /** A card (§12) next to the caller: HTML the agent wrote, isolated and offline unless the user allows more. */
  createCard(callerId: string, a: { title: string; html: string; refresh_script?: string; near_chat_id?: string }) {
    const near = a.near_chat_id ? this.chat(a.near_chat_id) : this.d.store.getChat(callerId);
    const p = this.placeNear(near);
    const node = this.d.cards.create({
      title: a.title,
      html: a.html,
      ...(a.refresh_script && { refreshScript: a.refresh_script }),
      x: p.x,
      y: p.y,
    });
    return {
      card_id: String(node.data.cardId),
      note: "The card has no network access and talks to Latis only through window.latis (data.get/set/list, refresh, ask, exportPdf, theme).",
    };
  }

  updateCard(cardId: string, a: { html?: string; refresh_script?: string; title?: string }) {
    if (a.html === undefined && a.refresh_script === undefined && !a.title) throw new ToolError("Pass html, refresh_script or title.");
    try {
      this.d.cards.update(cardId, {
        ...(a.html !== undefined && { html: a.html }),
        ...(a.refresh_script !== undefined && { refreshScript: a.refresh_script }),
        ...(a.title && { title: a.title }),
      });
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    return { card_id: cardId, updated: true };
  }

  /** Opens a focus view with these chats (chat ids or node ids). */
  focus(ids: string[], layout?: FocusView["layout"], name?: string) {
    const live = this.d.store.liveChats();
    const chatIds = ids.flatMap((id) => live.find((c) => c.id === id || c.nodeId === id)?.id ?? []);
    if (!chatIds.length) throw new ToolError("None of those ids is a chat. Use list_chats to see the ids.");
    const view: FocusView = {
      id: crypto.randomUUID(),
      name: name?.trim() || (chatIds.length === 1 ? live.find((c) => c.id === chatIds[0])!.title : `${chatIds.length} chats`),
      chatIds,
      layout: layout ?? (chatIds.length === 1 ? "stage" : chatIds.length <= 3 ? "columns" : "grid"),
    };
    this.d.store.setSetting("focusViews", [...(this.d.store.getSetting<FocusView[]>("focusViews") ?? []), view].slice(-30));
    this.d.ui.focus(view);
    return { view_id: view.id, chats: chatIds.length };
  }

  tidy() {
    this.d.ui.tidy();
    return { ok: true };
  }

  /** Only chats the caller spawned, and only after the user says yes (§10.1 guardrails). */
  async closeChat(callerId: string, chatId: string) {
    const c = this.chat(chatId);
    if (c.spawnedBy !== callerId) throw new ToolError("You can only close chats you started.");
    const ok = await this.d.confirm(
      `Close "${c.title}"?`,
      "A chat that the Conductor started wants to close it. You can restore it from ⌘K for 7 days.",
    );
    if (!ok) return { closed: false, reason: "The user said no." };
    await this.d.supervisor.release(chatId);
    this.d.store.softDelete([c.nodeId]);
    return { closed: true };
  }
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…[truncated]` : s;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
