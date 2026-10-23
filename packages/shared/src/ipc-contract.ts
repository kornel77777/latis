import { z } from "zod";
import { ChatStatus, StoredEvent } from "./agent-events";

// Single source of truth for every IPC channel (SPEC §5.2).
// `invoke` = request/response, `events` = main → renderer streams.

export const Theme = z.enum(["dark", "light", "system"]);
export type Theme = z.infer<typeof Theme>;

export const Viewport = z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.1).max(4) });
export type Viewport = z.infer<typeof Viewport>;

export const NodeType = z.enum(["chat", "terminal", "browser", "card", "note", "frame", "image", "flow"]);

export const CanvasNode = z.object({
  id: z.string(),
  canvasId: z.string(),
  projectId: z.string().nullable(),
  /** Containing frame node; child x/y are relative to it (React Flow sub-flows). */
  parentId: z.string().nullable(),
  type: NodeType,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  z: z.number(),
  data: z.record(z.string(), z.unknown()),
});
export type CanvasNode = z.infer<typeof CanvasNode>;

export const NodeGeometry = CanvasNode.pick({ id: true, x: true, y: true, w: true, h: true, z: true });
export type NodeGeometry = z.infer<typeof NodeGeometry>;

export const PermissionModeSchema = z.enum(["read-only", "ask", "auto-edit", "full-auto"]);

export const Project = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string(),
  folderPath: z.string(),
  frameNodeId: z.string(),
  folderMissing: z.boolean(),
  createdAt: z.number(),
});
export type Project = z.infer<typeof Project>;

export const ChatSummary = z.object({
  id: z.string(),
  nodeId: z.string(),
  projectId: z.string().nullable(),
  agentId: z.string(),
  model: z.string().nullable(),
  reasoning: z.string().nullable(),
  permissionMode: PermissionModeSchema,
  cwd: z.string(),
  title: z.string(),
  status: ChatStatus,
  /** True when the agent conversation can be resumed after a restart. */
  resumable: z.boolean(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

export const AgentInfo = z.object({
  id: z.string(),
  displayName: z.string(),
  hue: z.string(),
  installed: z.boolean(),
  version: z.string().optional(),
  signedIn: z.boolean(),
  account: z.string().optional(),
  installHint: z.string().optional(),
  /** Permission modes the adapter can't enforce, so the UI can warn (§9.8 AC3). */
  unenforceable: z.array(PermissionModeSchema),
  /** "terminal" agents run as a raw terminal in the chat card (§6.3 terminal-only). */
  kind: z.enum(["structured", "terminal"]),
  /** Messages sent mid-turn reach the agent at its next step (§9.9 AC2). */
  steering: z.boolean(),
  canSignIn: z.boolean(),
  source: z.enum(["built-in", "manifest"]),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const AgentModel = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  reasoningLevels: z.array(z.string()).optional(),
});
export type AgentModel = z.infer<typeof AgentModel>;

export const AttentionKind = z.enum(["permission", "question", "plan", "finished", "error", "rate_limited"]);
export type AttentionKind = z.infer<typeof AttentionKind>;

/** An open item in the Inbox (§8.6). `refId` is the request id for permission/question/plan. */
export const AttentionItem = z.object({
  id: z.string(),
  chatId: z.string(),
  kind: AttentionKind,
  refId: z.string().nullable(),
  summary: z.string(),
  detail: z.string().optional(),
  createdAt: z.number(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

/** A message waiting for the running turn to end (§9.9). */
export const QueuedMessage = z.object({ id: z.string(), text: z.string(), createdAt: z.number() });
export type QueuedMessage = z.infer<typeof QueuedMessage>;

export const PtyInfo = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  projectId: z.string().nullable(),
  /** Set for a terminal-only agent's chat, or a chat opened as a terminal. */
  chatId: z.string().nullable(),
  /** "chat": shown inside a terminal agent's chat card; "dock": a tab in the terminal dock. */
  place: z.enum(["dock", "chat"]),
  running: z.boolean(),
});
export type PtyInfo = z.infer<typeof PtyInfo>;

export const Prefs = z.object({
  onboarded: z.boolean(),
  notifyNeedsYou: z.boolean(),
  notifyFinished: z.boolean(),
});
export type Prefs = z.infer<typeof Prefs>;

export const Turn = z.object({
  id: z.string(),
  chatId: z.string(),
  seq: z.number().int(),
  userText: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.string(),
});
export type Turn = z.infer<typeof Turn>;

export const CanvasState = z.object({
  id: z.string(),
  name: z.string(),
  viewport: Viewport.nullable(),
  nodes: z.array(CanvasNode),
  chats: z.array(ChatSummary),
  projects: z.array(Project),
});
export type CanvasState = z.infer<typeof CanvasState>;

export const Transcript = z.object({ turns: z.array(Turn), events: z.array(StoredEvent) });
export type Transcript = z.infer<typeof Transcript>;

export const RespondPayload = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("permission"),
    decision: z.enum(["allow-once", "allow-chat", "allow-project", "deny"]),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal("answer"), answers: z.record(z.string(), z.string()) }),
  z.object({ kind: z.literal("plan"), approve: z.boolean(), feedback: z.string().optional() }),
]);
export type RespondPayload = z.infer<typeof RespondPayload>;

const none = z.undefined();
const ok = z.object({ ok: z.boolean() });

export const invokeContract = {
  "app:info": {
    req: none,
    res: z.object({ version: z.string(), platform: z.string(), dataDir: z.string() }),
  },
  "canvas:load": { req: none, res: CanvasState },
  "canvas:saveNodes": { req: z.object({ nodes: z.array(NodeGeometry) }), res: ok },
  "canvas:saveViewport": { req: z.object({ canvasId: z.string(), viewport: Viewport }), res: ok },
  "agents:list": { req: z.object({ refresh: z.boolean().optional() }), res: z.array(AgentInfo) },
  "agents:models": { req: z.object({ agentId: z.string() }), res: z.array(AgentModel) },
  /** Shows a folder picker; `null` when cancelled. */
  "project:openFolder": {
    req: z.object({ canvasId: z.string(), x: z.number(), y: z.number() }),
    res: z.object({ project: Project, node: CanvasNode, existed: z.boolean() }).nullable(),
  },
  "project:reveal": { req: z.object({ projectId: z.string() }), res: ok },
  "chat:create": {
    req: z.object({
      canvasId: z.string(),
      projectId: z.string().nullable(),
      agentId: z.string(),
      x: z.number(),
      y: z.number(),
      model: z.string().optional(),
      reasoning: z.string().optional(),
      permissionMode: PermissionModeSchema.optional(),
    }),
    /** `frame` is the project frame's new geometry when it grew to fit the chat. */
    res: z.object({ node: CanvasNode, chat: ChatSummary, frame: NodeGeometry.nullable() }),
  },
  "chat:transcript": { req: z.object({ chatId: z.string() }), res: Transcript },
  "chat:send": { req: z.object({ chatId: z.string(), text: z.string().min(1) }), res: Turn },
  "chat:respond": { req: z.object({ chatId: z.string(), requestId: z.string(), response: RespondPayload }), res: ok },
  "chat:interrupt": { req: z.object({ chatId: z.string() }), res: ok },
  "chat:restart": { req: z.object({ chatId: z.string() }), res: ok },
  "chat:setOptions": {
    req: z.object({
      chatId: z.string(),
      model: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      permissionMode: PermissionModeSchema.optional(),
      title: z.string().min(1).max(120).optional(),
    }),
    res: ChatSummary,
  },
  "chat:reveal": { req: z.object({ chatId: z.string(), path: z.string().optional() }), res: ok },
  /** While a turn runs: steer it when the agent can take it mid-turn, otherwise queue for after the turn (§9.9). */
  "chat:steer": {
    req: z.object({ chatId: z.string(), text: z.string().min(1) }),
    res: z.object({ delivered: z.enum(["steered", "queued", "sent"]), queue: z.array(QueuedMessage) }),
  },
  "chat:queue": { req: z.object({ chatId: z.string() }), res: z.array(QueuedMessage) },
  "chat:queueEdit": { req: z.object({ chatId: z.string(), id: z.string(), text: z.string().min(1) }), res: z.array(QueuedMessage) },
  "chat:queueRemove": { req: z.object({ chatId: z.string(), id: z.string() }), res: z.array(QueuedMessage) },
  /** Stops the running turn and sends this queued message right away. */
  "chat:sendNow": { req: z.object({ chatId: z.string(), id: z.string() }), res: ok },
  /** Stops the structured session and continues the conversation in the agent's own CLI in the dock (§9.2 AC5). */
  "chat:openTerminal": { req: z.object({ chatId: z.string() }), res: PtyInfo },
  /** A terminal-only agent's chat: starts its CLI if needed and returns the PTY to show. */
  "chat:attachTerminal": { req: z.object({ chatId: z.string() }), res: PtyInfo },
  /** The user looked at the chat: clears its finished/error items. */
  "chat:seen": { req: z.object({ chatId: z.string() }), res: ok },
  "attention:list": { req: none, res: z.array(AttentionItem) },
  "attention:dismiss": { req: z.object({ id: z.string() }), res: ok },
  /** Chats on screen right now; notifications for them are suppressed while the window is focused. */
  "ui:visibleChats": { req: z.object({ chatIds: z.array(z.string()) }), res: ok },
  "pty:create": { req: z.object({ projectId: z.string().nullable() }), res: PtyInfo },
  "pty:list": { req: none, res: z.array(PtyInfo) },
  /** Output so far (bounded), to repaint a terminal view that remounted. */
  "pty:snapshot": { req: z.object({ id: z.string() }), res: z.object({ data: z.string() }) },
  "pty:write": { req: z.object({ id: z.string(), data: z.string() }), res: ok },
  "pty:resize": { req: z.object({ id: z.string(), cols: z.number().int().min(2), rows: z.number().int().min(1) }), res: ok },
  "pty:kill": { req: z.object({ id: z.string() }), res: ok },
  /** Runs the agent's own sign-in in a dock terminal. */
  "agents:login": { req: z.object({ agentId: z.string() }), res: PtyInfo },
  /** Opens <dataDir>/agents (manifests) in the file manager. */
  "agents:openFolder": { req: none, res: ok },
  "agents:manifestErrors": { req: none, res: z.record(z.string(), z.string()) },
  /** Onboarding: a fresh folder under the data dir, opened as a project. */
  "project:createSandbox": {
    req: z.object({ canvasId: z.string(), x: z.number(), y: z.number() }),
    res: z.object({ project: Project, node: CanvasNode, existed: z.boolean() }),
  },
  "prefs:get": { req: none, res: Prefs },
  "prefs:set": { req: Prefs.partial(), res: Prefs },
  "settings:getTheme": { req: none, res: Theme },
  "settings:setTheme": { req: Theme, res: Theme },
} as const;

export const eventContract = {
  "chat:events": z.object({ chatId: z.string(), events: z.array(StoredEvent) }),
  "chat:status": z.object({ chatId: z.string(), status: ChatStatus, title: z.string().optional() }),
  "chat:updated": ChatSummary,
  "chat:queue": z.object({ chatId: z.string(), queue: z.array(QueuedMessage) }),
  /** A turn main started on its own (a queued message going out). */
  "chat:turn": Turn,
  "attention:changed": z.array(AttentionItem),
  "pty:data": z.object({ id: z.string(), data: z.string() }),
  "pty:exit": z.object({ id: z.string(), code: z.number().nullable() }),
  /** Main opened a terminal (sign-in, open-as-terminal); the dock should show it. */
  "pty:opened": PtyInfo,
  /** A notification was clicked: pan to this chat. */
  "focus:chat": z.object({ chatId: z.string() }),
  "agents:changed": z.array(AgentInfo),
} as const;

export type InvokeChannel = keyof typeof invokeContract;
export type EventChannel = keyof typeof eventContract;
export type InvokeReq<C extends InvokeChannel> = z.input<(typeof invokeContract)[C]["req"]>;
export type InvokeRes<C extends InvokeChannel> = z.output<(typeof invokeContract)[C]["res"]>;
export type EventPayload<C extends EventChannel> = z.output<(typeof eventContract)[C]>;

export const invokeChannels = Object.keys(invokeContract) as InvokeChannel[];
export const eventChannels = Object.keys(eventContract) as EventChannel[];

/** The object the preload exposes as `window.latis`. */
export interface LatisApi {
  invoke<C extends InvokeChannel>(channel: C, ...req: InvokeReq<C> extends undefined ? [] : [InvokeReq<C>]): Promise<InvokeRes<C>>;
  on<C extends EventChannel>(channel: C, listener: (payload: EventPayload<C>) => void): () => void;
  platform: string;
}

/** Envelope for invoke responses so main-side failures cross IPC as data, not thrown Errors. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string };
