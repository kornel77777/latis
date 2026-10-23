import { applyNodeChanges, type Node, type NodeChange, type Viewport } from "@xyflow/react";
import { create } from "zustand";
import {
  eventContract,
  type AgentInfo,
  type AgentModel,
  type AttentionItem,
  type Prefs,
  type PtyInfo,
  type QueuedMessage,
  type ReviewItem,
  type TimelineEntry,
  type CanvasNode,
  type ChatStatus,
  type ChatSummary,
  type NodeGeometry,
  type Project,
  type RespondPayload,
  type StoredEvent,
  type Theme,
  type Turn,
} from "@latis/shared";
import { latis } from "../api";

export interface ChatState {
  summary: ChatSummary;
  turns: Turn[];
  events: StoredEvent[];
  lastSeq: number;
  loaded: boolean;
}

export type FlowNode = Node<{ chatId?: string; projectId?: string }>;

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
}

export type ChatOptions = Partial<Pick<ChatSummary, "model" | "reasoning" | "permissionMode" | "title">>;

interface WorkspaceState {
  ready: boolean;
  loadError: string | null;
  canvasId: string;
  initialViewport: Viewport | null;
  nodes: FlowNode[];
  chats: Record<string, ChatState>;
  projects: Record<string, Project>;
  agents: AgentInfo[];
  models: Record<string, AgentModel[]>;
  toasts: Toast[];
  /** Node to pan/zoom to; CanvasView consumes it. */
  focusRequest: { nodeId: string; n: number } | null;
  theme: Theme;
  sidebarOpen: boolean;
  sidebarTab: "projects" | "inbox";
  dockOpen: boolean;
  /** Open Inbox items, newest first (§8.6). */
  attention: AttentionItem[];
  queues: Record<string, QueuedMessage[]>;
  ptys: PtyInfo[];
  activePty: string | null;
  prefs: Prefs | null;
  settingsOpen: boolean;
  onboardingOpen: boolean;
  /** Index into `attention` that Ctrl+J last jumped to. */
  jumpIndex: number;
  /** Composer text to start a chat with (onboarding starter prompts). */
  drafts: Record<string, string>;
  /** Review Inbox items (§9.5): open ones plus recently reviewed. */
  reviews: ReviewItem[];
  /** Review panel (Ctrl+Shift+R); `chatId` opens a worktree's whole-branch diff instead. */
  reviewPanel: { open: boolean; reviewId?: string; branchOf?: string };
  timelines: Record<string, TimelineEntry[]>;
  /** Pending "work in its own copy?" question for a new chat (§9.3 AC1, AC6). */
  isolateOffer: { agentId: string; projectId: string; isRepo: boolean } | null;
  /** Chat whose worktree merge dialog is open. */
  mergeFor: string | null;
  /** Chat whose timeline dialog is open. */
  timelineFor: string | null;

  load(): Promise<void>;
  loadAgents(refresh?: boolean): Promise<void>;
  loadModels(agentId: string): Promise<AgentModel[]>;
  onNodesChange(changes: NodeChange<FlowNode>[]): void;
  saveViewport(v: Viewport): void;
  openFolder(at: { x: number; y: number }): Promise<Project | null>;
  createChat(input: {
    agentId: string;
    projectId: string | null;
    x?: number;
    y?: number;
    draft?: string;
    isolate?: boolean;
  }): Promise<string | null>;
  focusNode(nodeId: string): void;
  loadTranscript(chatId: string): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
  respond(chatId: string, requestId: string, response: RespondPayload): Promise<void>;
  interrupt(chatId: string): Promise<void>;
  restart(chatId: string): Promise<void>;
  setChatOptions(chatId: string, options: ChatOptions): Promise<void>;
  reveal(chatId: string, path?: string): Promise<void>;
  toast(message: string, action?: Toast["action"]): void;
  dismissToast(id: number): void;
  setTheme(t: Theme): Promise<void>;
  toggleSidebar(): void;
  toggleDock(): void;
  setSidebarTab(tab: WorkspaceState["sidebarTab"]): void;
  /** Composer submit while a turn runs: steer or queue (§9.9). */
  steer(chatId: string, text: string): Promise<void>;
  editQueued(chatId: string, id: string, text: string): Promise<void>;
  removeQueued(chatId: string, id: string): Promise<void>;
  sendNow(chatId: string, id: string): Promise<void>;
  focusChat(chatId: string): void;
  markSeen(chatId: string): void;
  dismissAttention(id: string): Promise<void>;
  /** Ctrl+J / Ctrl+Shift+J. */
  jumpAttention(dir: 1 | -1): void;
  newTerminal(projectId: string | null): Promise<void>;
  showPty(info: PtyInfo): void;
  closePty(id: string): Promise<void>;
  openAsTerminal(chatId: string): Promise<void>;
  signIn(agentId: string): Promise<void>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  setSettingsOpen(open: boolean): void;
  finishOnboarding(): Promise<void>;
  createSandbox(): Promise<Project | null>;
  /** New chat in a project: asks about a separate worktree first when another chat already works there. */
  startChat(agentId: string, projectId: string): Promise<void>;
  loadTimeline(chatId: string): Promise<void>;
  undoTurn(chatId: string, turnId: string): Promise<void>;
  redoTurn(chatId: string, turnId: string): Promise<void>;
  restoreTo(chatId: string, turnId: string): Promise<void>;
  openReview(target?: { reviewId?: string; branchOf?: string }): void;
  closeReview(): void;
  updateReview(item: ReviewItem): void;
}

function toFlowNode(n: CanvasNode): FlowNode {
  return {
    id: n.id,
    type: n.type,
    position: { x: n.x, y: n.y },
    width: n.w,
    height: n.h,
    zIndex: n.z,
    data: n.data as FlowNode["data"],
    dragHandle: n.type === "frame" ? ".latis-frame-drag" : ".latis-drag",
    ...(n.parentId && { parentId: n.parentId }),
  };
}

/** React Flow requires parents before their children. */
function sortNodes(nodes: FlowNode[]): FlowNode[] {
  return [...nodes.filter((n) => !n.parentId), ...nodes.filter((n) => n.parentId)];
}

let toastSeq = 0;
const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

function geometry(n: FlowNode): NodeGeometry {
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.width ?? n.measured?.width ?? 440,
    h: n.height ?? n.measured?.height ?? 560,
    z: n.zIndex ?? 0,
  };
}

// Debounced persistence (SPEC §7.2: 300 ms). On failure keep retrying; in-memory state is never discarded.
const dirty = new Set<string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(get: () => WorkspaceState, delay = 300) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ids = new Set(dirty);
    dirty.clear();
    const nodes = get()
      .nodes.filter((n) => ids.has(n.id))
      .map(geometry);
    latis.invoke("canvas:saveNodes", { nodes }).catch((err: unknown) => {
      console.error("save failed, retrying", err);
      ids.forEach((id) => dirty.add(id));
      scheduleSave(get, 2000);
    });
  }, delay);
}

let viewportTimer: ReturnType<typeof setTimeout> | null = null;

// Main → renderer events are applied once per animation frame (SPEC §5).
let pendingEvents: StoredEvent[] = [];
let frame = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ready: false,
  loadError: null,
  canvasId: "main",
  initialViewport: null,
  nodes: [],
  chats: {},
  projects: {},
  agents: [],
  models: {},
  toasts: [],
  focusRequest: null,
  theme: "dark",
  sidebarOpen: true,
  sidebarTab: "projects",
  dockOpen: false,
  attention: [],
  queues: {},
  ptys: [],
  activePty: null,
  prefs: null,
  settingsOpen: false,
  onboardingOpen: false,
  jumpIndex: -1,
  drafts: {},
  reviews: [],
  reviewPanel: { open: false },
  timelines: {},
  isolateOffer: null,
  mergeFor: null,
  timelineFor: null,

  async load() {
    try {
      const [canvas, theme, attention, ptys, prefs, reviews] = await Promise.all([
        latis.invoke("canvas:load"),
        latis.invoke("settings:getTheme"),
        latis.invoke("attention:list"),
        latis.invoke("pty:list"),
        latis.invoke("prefs:get"),
        latis.invoke("reviews:list"),
      ]);
      const chats: Record<string, ChatState> = {};
      for (const c of canvas.chats) chats[c.id] = { summary: c, turns: [], events: [], lastSeq: -1, loaded: false };
      set({
        ready: true,
        canvasId: canvas.id,
        initialViewport: canvas.viewport,
        nodes: sortNodes(canvas.nodes.map(toFlowNode)),
        chats,
        projects: Object.fromEntries(canvas.projects.map((p) => [p.id, p])),
        theme,
        attention,
        ptys: ptys.filter((p) => p.place === "dock"),
        activePty: ptys.find((p) => p.place === "dock")?.id ?? null,
        prefs,
        reviews,
        // First run: nothing on the canvas and onboarding never finished (§8.10).
        onboardingOpen: !prefs.onboarded && canvas.nodes.length === 0,
      });
      void get().loadAgents();
      await Promise.all(canvas.chats.map((c) => Promise.all([get().loadTranscript(c.id), get().loadTimeline(c.id)])));
    } catch (err) {
      set({ loadError: err instanceof Error ? err.message : String(err) });
    }
  },

  onNodesChange(changes) {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
    for (const c of changes) {
      if ((c.type === "position" && c.dragging === false) || (c.type === "dimensions" && c.resizing === false)) {
        dirty.add(c.id);
      }
    }
    if (dirty.size) scheduleSave(get);
  },

  saveViewport(v) {
    if (viewportTimer) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      latis.invoke("canvas:saveViewport", { canvasId: get().canvasId, viewport: v }).catch(console.error);
    }, 300);
  },

  async loadAgents(refresh) {
    try {
      const agents = await latis.invoke("agents:list", { refresh: refresh ?? false });
      if (refresh) set({ models: {} });
      set({ agents });
      // Model lists come from the agent CLI without sending a message (no tokens); fetch them so pickers show names.
      for (const a of agents)
        if (a.installed && a.id !== "fake")
          void get()
            .loadModels(a.id)
            .catch(() => undefined);
    } catch (err) {
      get().toast(`Couldn't check agents: ${errorText(err)}`);
    }
  },

  async loadModels(agentId) {
    const cached = get().models[agentId];
    if (cached) return cached;
    const models = await latis.invoke("agents:models", { agentId });
    set((s) => ({ models: { ...s.models, [agentId]: models } }));
    return models;
  },

  async openFolder(at) {
    try {
      const r = await latis.invoke("project:openFolder", { canvasId: get().canvasId, x: Math.round(at.x), y: Math.round(at.y) });
      if (!r) return null;
      set((s) => ({
        projects: { ...s.projects, [r.project.id]: r.project },
        nodes: r.existed ? s.nodes : sortNodes([...s.nodes, toFlowNode(r.node)]),
      }));
      get().focusNode(r.node.id);
      return r.project;
    } catch (err) {
      get().toast(`Couldn't open the folder: ${errorText(err)}`);
      return null;
    }
  },

  async createChat({ agentId, projectId, x = 0, y = 0, draft, isolate }) {
    try {
      const { node, chat, frame } = await latis.invoke("chat:create", {
        canvasId: get().canvasId,
        projectId,
        agentId,
        x: Math.round(x),
        y: Math.round(y),
        ...(isolate && { isolate }),
      });
      set((s) => ({
        nodes: sortNodes([
          ...s.nodes.map((n) => {
            const base = { ...n, selected: false };
            return frame && n.id === frame.id ? { ...base, width: frame.w, height: frame.h } : base;
          }),
          { ...toFlowNode(node), selected: true },
        ]),
        chats: { ...s.chats, [chat.id]: { summary: chat, turns: [], events: [], lastSeq: -1, loaded: true } },
        ...(draft && { drafts: { ...s.drafts, [chat.id]: draft } }),
      }));
      get().focusNode(node.id);
      return chat.id;
    } catch (err) {
      get().toast(errorText(err));
      return null;
    }
  },

  focusNode(nodeId) {
    set((s) => ({ focusRequest: { nodeId, n: (s.focusRequest?.n ?? 0) + 1 } }));
  },

  async loadTranscript(chatId) {
    const t = await latis.invoke("chat:transcript", { chatId });
    set((s) => {
      const prev = s.chats[chatId];
      if (!prev) return s;
      // Keep any live events that arrived while the transcript was loading.
      const lastSeq = t.events.at(-1)?.seq ?? -1;
      const live = prev.events.filter((e) => e.seq > lastSeq);
      return {
        chats: {
          ...s.chats,
          [chatId]: { ...prev, turns: t.turns, events: [...t.events, ...live], lastSeq: live.at(-1)?.seq ?? lastSeq, loaded: true },
        },
      };
    });
  },

  async send(chatId, text) {
    let turn: Turn;
    try {
      turn = await latis.invoke("chat:send", { chatId, text });
    } catch (err) {
      get().toast(`Message not sent: ${errorText(err)}`);
      return;
    }
    addTurn(turn);
  },

  async respond(chatId, requestId, response) {
    const r = await latis.invoke("chat:respond", { chatId, requestId, response });
    if (!r.ok) get().toast("That request is no longer waiting. The agent may have been restarted.");
  },
  async interrupt(chatId) {
    await latis.invoke("chat:interrupt", { chatId });
  },
  async restart(chatId) {
    await latis.invoke("chat:restart", { chatId });
  },

  async setChatOptions(chatId, options) {
    try {
      const summary = await latis.invoke("chat:setOptions", { chatId, ...options });
      applySummary(summary);
    } catch (err) {
      get().toast(errorText(err));
    }
  },

  async reveal(chatId, path) {
    const r = await latis.invoke("chat:reveal", { chatId, ...(path && { path }) });
    if (!r.ok) get().toast(`Couldn't open ${path ?? "the folder"}.`);
  },

  toast(message, action) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, message, ...(action && { action }) }].slice(-4) }));
    setTimeout(() => get().dismissToast(id), 6000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  async setTheme(theme) {
    set({ theme: await latis.invoke("settings:setTheme", theme) });
  },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setSidebarTab: (tab) => set({ sidebarTab: tab, sidebarOpen: true }),

  async steer(chatId, text) {
    try {
      const r = await latis.invoke("chat:steer", { chatId, text });
      set((s) => ({ queues: { ...s.queues, [chatId]: r.queue } }));
      if (r.delivered === "sent") await get().loadTranscript(chatId);
    } catch (err) {
      get().toast(`Message not sent: ${errorText(err)}`);
    }
  },
  async editQueued(chatId, id, text) {
    const queue = await latis.invoke("chat:queueEdit", { chatId, id, text });
    set((s) => ({ queues: { ...s.queues, [chatId]: queue } }));
  },
  async removeQueued(chatId, id) {
    const queue = await latis.invoke("chat:queueRemove", { chatId, id });
    set((s) => ({ queues: { ...s.queues, [chatId]: queue } }));
  },
  async sendNow(chatId, id) {
    await latis.invoke("chat:sendNow", { chatId, id });
  },

  focusChat(chatId) {
    const c = get().chats[chatId];
    if (!c) return;
    set((s) => ({ nodes: s.nodes.map((n) => ({ ...n, selected: n.id === c.summary.nodeId })) }));
    get().focusNode(c.summary.nodeId);
    get().markSeen(chatId);
  },
  markSeen(chatId) {
    if (!get().attention.some((a) => a.chatId === chatId && (a.kind === "finished" || a.kind === "error" || a.kind === "rate_limited")))
      return;
    void latis.invoke("chat:seen", { chatId }).catch(console.error);
  },
  async dismissAttention(id) {
    await latis.invoke("attention:dismiss", { id });
  },
  jumpAttention(dir) {
    const items = get().attention;
    if (!items.length) {
      get().toast("Nothing needs you right now.");
      return;
    }
    const i = (((get().jumpIndex + dir) % items.length) + items.length) % items.length;
    set({ jumpIndex: i });
    get().focusChat(items[i]!.chatId);
  },

  async newTerminal(projectId) {
    try {
      get().showPty(await latis.invoke("pty:create", { projectId }));
    } catch (err) {
      get().toast(`Couldn't open a terminal: ${errorText(err)}`);
    }
  },
  showPty(info) {
    set((s) => ({
      ptys: s.ptys.some((p) => p.id === info.id) ? s.ptys.map((p) => (p.id === info.id ? info : p)) : [...s.ptys, info],
      activePty: info.id,
      dockOpen: true,
    }));
  },
  async closePty(id) {
    const p = get().ptys.find((x) => x.id === id);
    await latis.invoke("pty:kill", { id });
    // A running terminal gets its exit event first; one that already exited is forgotten now.
    if (p && !p.running) await latis.invoke("pty:kill", { id }).catch(() => undefined);
    set((s) => {
      const ptys = s.ptys.filter((x) => x.id !== id);
      return { ptys, activePty: s.activePty === id ? (ptys.at(-1)?.id ?? null) : s.activePty };
    });
  },
  async openAsTerminal(chatId) {
    try {
      get().showPty(await latis.invoke("chat:openTerminal", { chatId }));
    } catch (err) {
      get().toast(`Couldn't open a terminal: ${errorText(err)}`);
    }
  },
  async signIn(agentId) {
    try {
      get().showPty(await latis.invoke("agents:login", { agentId }));
    } catch (err) {
      get().toast(errorText(err));
    }
  },

  async setPrefs(patch) {
    set({ prefs: await latis.invoke("prefs:set", patch) });
  },
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  async finishOnboarding() {
    set({ onboardingOpen: false });
    await get().setPrefs({ onboarded: true });
  },
  async startChat(agentId, projectId) {
    try {
      const g = await latis.invoke("project:git", { projectId });
      // §9.3 AC1: a second chat in the same repo gets the offer of its own copy (default on).
      if (g.chats > 0 && g.isRepo) {
        set({ isolateOffer: { agentId, projectId, isRepo: true } });
        return;
      }
      if (g.chats > 0 && !g.gitMissing) {
        // AC6: no git, no copies. Don't block; offer to set it up.
        await get().createChat({ agentId, projectId });
        get().toast("This folder isn't a git repository, so its chats share it and can't be undone or reviewed.", {
          label: "Initialise git",
          run: () =>
            void latis
              .invoke("project:initGit", { projectId })
              .then(() => get().toast("Git initialised. New chats here can have their own copy."))
              .catch((err: unknown) => get().toast(errorText(err))),
        });
        return;
      }
    } catch (err) {
      console.warn("git check failed", err);
    }
    await get().createChat({ agentId, projectId });
  },
  async loadTimeline(chatId) {
    const entries = await latis.invoke("chat:timeline", { chatId });
    set((s) => ({ timelines: { ...s.timelines, [chatId]: entries } }));
  },
  async undoTurn(chatId, turnId) {
    try {
      const entries = await latis.invoke("chat:undoTurn", { chatId, turnId });
      set((s) => ({ timelines: { ...s.timelines, [chatId]: entries } }));
      get().toast("Turn undone. The agent will be told with your next message.", {
        label: "Redo",
        run: () => void get().redoTurn(chatId, turnId),
      });
    } catch (err) {
      get().toast(errorText(err));
    }
  },
  async redoTurn(chatId, turnId) {
    try {
      const entries = await latis.invoke("chat:redoTurn", { chatId, turnId });
      set((s) => ({ timelines: { ...s.timelines, [chatId]: entries } }));
    } catch (err) {
      get().toast(errorText(err));
    }
  },
  async restoreTo(chatId, turnId) {
    try {
      const entries = await latis.invoke("chat:restoreTo", { chatId, turnId });
      set((s) => ({ timelines: { ...s.timelines, [chatId]: entries } }));
      get().toast("Files restored. The agent will be told with your next message.");
    } catch (err) {
      get().toast(errorText(err));
    }
  },
  openReview(target) {
    set({ reviewPanel: { open: true, ...target } });
  },
  closeReview: () => set({ reviewPanel: { open: false } }),
  updateReview(item) {
    set((s) => ({ reviews: s.reviews.map((r) => (r.id === item.id ? item : r)) }));
  },

  async createSandbox() {
    try {
      const r = await latis.invoke("project:createSandbox", { canvasId: get().canvasId, x: 0, y: 0 });
      set((s) => ({
        projects: { ...s.projects, [r.project.id]: r.project },
        nodes: r.existed ? s.nodes : sortNodes([...s.nodes, toFlowNode(r.node)]),
      }));
      get().focusNode(r.node.id);
      return r.project;
    } catch (err) {
      get().toast(`Couldn't create the sandbox: ${errorText(err)}`);
      return null;
    }
  },
}));

function flushEvents() {
  frame = 0;
  const batch = pendingEvents;
  pendingEvents = [];
  useWorkspace.setState((s) => {
    const chats = { ...s.chats };
    for (const se of batch) {
      const c = chats[se.chatId];
      if (!c || se.seq <= c.lastSeq) continue;
      chats[se.chatId] = { ...c, events: [...c.events, se], lastSeq: se.seq };
    }
    return { chats };
  });
}

/** Adds a turn once, whether it came back from `chat:send` or arrived as a `chat:turn` event. */
function addTurn(turn: Turn) {
  useWorkspace.setState((s) => {
    const c = s.chats[turn.chatId];
    if (!c || c.turns.some((t) => t.id === turn.id)) return s;
    return { chats: { ...s.chats, [turn.chatId]: { ...c, turns: [...c.turns, turn] } } };
  });
}

function setStatus(chatId: string, status: ChatStatus) {
  useWorkspace.setState((s) => {
    const c = s.chats[chatId];
    if (!c) return s;
    return { chats: { ...s.chats, [chatId]: { ...c, summary: { ...c.summary, status } } } };
  });
}

function applySummary(summary: ChatSummary) {
  useWorkspace.setState((s) => {
    const c = s.chats[summary.id];
    if (!c) return s;
    return { chats: { ...s.chats, [summary.id]: { ...c, summary: { ...summary, status: c.summary.status } } } };
  });
}

let subscribed = false;
export function subscribeToMain(): void {
  if (subscribed) return;
  subscribed = true;
  latis.on("chat:events", (raw) => {
    const parsed = eventContract["chat:events"].safeParse(raw);
    if (!parsed.success) return console.warn("dropped invalid chat:events payload");
    pendingEvents.push(...parsed.data.events);
    frame ||= requestAnimationFrame(flushEvents);
  });
  latis.on("chat:status", (raw) => {
    const parsed = eventContract["chat:status"].safeParse(raw);
    if (!parsed.success) return console.warn("dropped invalid chat:status payload");
    setStatus(parsed.data.chatId, parsed.data.status);
  });
  latis.on("chat:updated", (raw) => {
    const parsed = eventContract["chat:updated"].safeParse(raw);
    if (!parsed.success) return console.warn("dropped invalid chat:updated payload");
    applySummary(parsed.data);
  });
  latis.on("chat:queue", (raw) => {
    const parsed = eventContract["chat:queue"].safeParse(raw);
    if (!parsed.success) return console.warn("dropped invalid chat:queue payload");
    const { chatId, queue } = parsed.data;
    useWorkspace.setState((s) => ({ queues: { ...s.queues, [chatId]: queue } }));
  });
  latis.on("reviews:changed", (raw) => {
    const parsed = eventContract["reviews:changed"].safeParse(raw);
    if (parsed.success) useWorkspace.setState({ reviews: parsed.data });
  });
  latis.on("chat:timeline", (raw) => {
    const parsed = eventContract["chat:timeline"].safeParse(raw);
    if (parsed.success) useWorkspace.setState((s) => ({ timelines: { ...s.timelines, [parsed.data.chatId]: parsed.data.entries } }));
  });
  latis.on("chat:turn", (raw) => {
    const parsed = eventContract["chat:turn"].safeParse(raw);
    if (parsed.success) addTurn(parsed.data);
  });
  latis.on("attention:changed", (raw) => {
    const parsed = eventContract["attention:changed"].safeParse(raw);
    if (!parsed.success) return console.warn("dropped invalid attention payload");
    useWorkspace.setState({ attention: parsed.data });
  });
  latis.on("pty:opened", (raw) => {
    const parsed = eventContract["pty:opened"].safeParse(raw);
    if (parsed.success && parsed.data.place === "dock") useWorkspace.getState().showPty(parsed.data);
  });
  latis.on("pty:exit", (raw) => {
    const parsed = eventContract["pty:exit"].safeParse(raw);
    if (!parsed.success) return;
    useWorkspace.setState((s) => ({ ptys: s.ptys.map((p) => (p.id === parsed.data.id ? { ...p, running: false } : p)) }));
  });
  latis.on("focus:chat", (raw) => {
    const parsed = eventContract["focus:chat"].safeParse(raw);
    if (parsed.success) useWorkspace.getState().focusChat(parsed.data.chatId);
  });
  latis.on("agents:changed", (raw) => {
    const parsed = eventContract["agents:changed"].safeParse(raw);
    if (parsed.success) useWorkspace.setState({ agents: parsed.data, models: {} });
  });
}
