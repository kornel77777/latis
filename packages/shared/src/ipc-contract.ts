import { z } from "zod";
import { ChatStatus, StoredEvent, UsageWindow } from "./agent-events";

// Single source of truth for every IPC channel (SPEC §5.2).
// `invoke` = request/response, `events` = main → renderer streams.

export const Theme = z.enum(["dark", "light", "system"]);
export type Theme = z.infer<typeof Theme>;

export const Viewport = z.object({ x: z.number(), y: z.number(), zoom: z.number().min(0.1).max(4) });
export type Viewport = z.infer<typeof Viewport>;

export const NodeType = z.enum(["chat", "terminal", "browser", "card", "note", "frame", "image", "flow", "start", "label"]);

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

/** A chat's own git worktree (§9.3). */
export const WorktreeInfo = z.object({
  id: z.string(),
  branch: z.string(),
  baseRef: z.string(),
  path: z.string(),
  merged: z.boolean(),
  removed: z.boolean(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfo>;

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
  worktree: WorktreeInfo.nullable(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  /** "conductor" for the pinned Conductor chat (§10.2). */
  role: z.enum(["conductor"]).nullable(),
  /** The chat can use the Workspace MCP tools (§10.1). */
  workspaceTools: z.boolean(),
  /** The chat that started this one through the workspace tools. */
  spawnedBy: z.string().nullable(),
  /** MCP connections attached to this chat on top of the shared ones (§9.15). */
  connections: z.array(z.string()),
  /** The chat this one continues (handoff, §9.11). */
  continuedFrom: z.string().nullable(),
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
  /** Agents that take an API key (the chat-view Claude): where it comes from, if anywhere. */
  apiKey: z.enum(["saved", "shell", "none"]).optional(),
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
export const QueuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  /** Images queued with the message (base64), sent when it goes out. */
  images: z.array(z.object({ mime: z.string(), dataBase64: z.string() })).optional(),
});
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

// ── Flows (§11) ──────────────────────────────────────────────────────────────

export const EdgeMode = z.enum(["every", "free", "wait_all", "approval"]);
export type EdgeMode = z.infer<typeof EdgeMode>;

export const FlowEdge = z.object({ id: z.string(), flowId: z.string(), source: z.string(), target: z.string(), mode: EdgeMode });
export type FlowEdge = z.infer<typeof FlowEdge>;

export const FlowSchedule = z.object({
  every: z.enum(["hourly", "daily", "weekly"]),
  /** "HH:MM", local time (minutes past the hour for hourly). */
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** 0 = Sunday, for weekly. */
  weekday: z.number().int().min(0).max(6).optional(),
});
export type FlowSchedule = z.infer<typeof FlowSchedule>;

export const GateKind = z.enum(["pick", "review", "shortlist", "form", "results"]);
export type GateKind = z.infer<typeof GateKind>;

/** What `create_flow` and the templates build from (§11.6). */
export const FlowSpec = z.object({
  name: z.string().min(1).max(80),
  brief: z.string().max(4000).optional(),
  /** Folder the flow's chats work in; a scratch folder if left out. */
  cwd: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  schedule: FlowSchedule.nullable().optional(),
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        type: z.enum(["start", "chat", "note", "card"]),
        title: z.string().max(80).optional(),
        agent: z.string().optional(),
        job: z.string().max(4000).optional(),
        oneTaskPerLine: z.boolean().optional(),
        gate: GateKind.optional(),
        /** Form gate: the fields to fill in. */
        fields: z.array(z.string().max(60)).max(12).optional(),
        /** Start: what a scheduled run starts with. */
        input: z.string().max(4000).optional(),
      }),
    )
    .min(1)
    .max(24),
  edges: z.array(z.object({ from: z.string(), to: z.string(), mode: EdgeMode.optional() })).max(60),
});
export type FlowSpec = z.infer<typeof FlowSpec>;

export const FlowApproval = z.object({ id: z.string(), edgeId: z.string(), from: z.string(), to: z.string(), text: z.string() });
export type FlowApproval = z.infer<typeof FlowApproval>;

export const FlowRunInfo = z.object({
  id: z.string(),
  status: z.enum(["running", "paused", "done", "stopped", "error"]),
  trigger: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** Items waiting on approval edges (§11.2). */
  approvals: z.array(FlowApproval),
  /** The loop guard tripped: Continue or Stop (§11.3). */
  loopCheck: z.boolean(),
  handoffs: z.number(),
  log: z.array(z.object({ at: z.number(), text: z.string() })),
});
export type FlowRunInfo = z.infer<typeof FlowRunInfo>;

export const FlowInfo = z.object({
  id: z.string(),
  nodeId: z.string(),
  name: z.string(),
  brief: z.string(),
  schedule: FlowSchedule.nullable(),
  nextRunAt: z.number().nullable(),
  loopLimit: z.number(),
  run: FlowRunInfo.nullable(),
});
export type FlowInfo = z.infer<typeof FlowInfo>;

// ── Lattice: chats tiled in splits ────────────────────────────────────────────

export type LatticeNode =
  { kind: "pane"; chatId: string } | { kind: "split"; dir: "row" | "col"; sizes: number[]; children: LatticeNode[] };
export const LatticeNode: z.ZodType<LatticeNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("pane"), chatId: z.string() }),
    z.object({ kind: z.literal("split"), dir: z.enum(["row", "col"]), sizes: z.array(z.number()), children: z.array(LatticeNode) }),
  ]),
);

export const LatticeState = z.object({
  root: LatticeNode.nullable(),
  /** Only this project's chats (null: every chat). */
  projectId: z.string().nullable(),
  /** Chats taken out of the lattice; they stay on the canvas. */
  hidden: z.array(z.string()),
});
export type LatticeState = z.infer<typeof LatticeState>;

/** A message waiting to be sent later (§9.10). */
export const ScheduledMessage = z.object({
  id: z.string(),
  chatId: z.string(),
  text: z.string(),
  fireAt: z.number(),
  repeatMs: z.number().nullable(),
  onReset: z.boolean(),
});
export type ScheduledMessage = z.infer<typeof ScheduledMessage>;

/** What Latis knows about each agent's usage (§9.12), by agent id. Unknown stays unknown. */
export const UsageState = z.record(
  z.string(),
  z.object({
    windows: z.array(UsageWindow),
    /** Set while the agent reported a usage limit; when it resets, if it said. */
    limited: z.object({ resetsAt: z.string().nullable(), message: z.string() }).nullable(),
    updatedAt: z.number(),
  }),
);
export type UsageState = z.infer<typeof UsageState>;

/** An extra account for an agent (§9.12 AC3): a separate home folder for its CLI. */
export const Account = z.object({ id: z.string(), agentId: z.string(), label: z.string(), home: z.string() });
export type Account = z.infer<typeof Account>;
/** `active[agentId]` is the account in use; null or missing is the CLI's default home. */
export const AccountsState = z.object({ accounts: z.array(Account), active: z.record(z.string(), z.string().nullable()) });
export type AccountsState = z.infer<typeof AccountsState>;

/** An MCP connection (§9.15). Secret values never leave main; only their names do. */
export const McpConnection = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  envKeys: z.array(z.string()),
  headerKeys: z.array(z.string()),
  /** Passed to every chat whose agent supports MCP. */
  shared: z.boolean(),
});
export type McpConnection = z.infer<typeof McpConnection>;

const McpName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - and _ only.");

export const McpConnectionInput = z.object({
  /** Updates this connection; secrets left out keep their saved values. */
  id: z.string().optional(),
  name: McpName,
  transport: z.enum(["stdio", "http"]),
  command: z.string().max(4000).optional(),
  args: z.array(z.string().max(4000)).max(100).optional(),
  url: z.string().url().max(4000).optional(),
  env: z.record(z.string(), z.string().max(20_000)).optional(),
  headers: z.record(z.string(), z.string().max(20_000)).optional(),
  shared: z.boolean(),
});
export type McpConnectionInput = z.infer<typeof McpConnectionInput>;

/** MCP servers found in another app's config, shown before anything is copied (§9.15 AC2). */
export const McpImportCandidate = z.object({
  source: z.string(),
  path: z.string(),
  servers: z.array(
    z.object({
      name: z.string(),
      transport: z.enum(["stdio", "http"]),
      command: z.string().nullable(),
      args: z.array(z.string()),
      url: z.string().nullable(),
      envKeys: z.array(z.string()),
      headerKeys: z.array(z.string()),
      /** A connection with this name already exists. */
      exists: z.boolean(),
    }),
  ),
});
export type McpImportCandidate = z.infer<typeof McpImportCandidate>;

/** A reusable prompt snippet (§9.14), used as /name in the composer. */
export const Skill = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["user", "project"]),
  path: z.string(),
});
export type Skill = z.infer<typeof Skill>;

/** A saved focus view (§8.7), shown as a title-bar tab. */
export const FocusView = z.object({
  id: z.string(),
  name: z.string(),
  chatIds: z.array(z.string()),
  layout: z.enum(["grid", "stage", "columns"]),
  /** The chat on stage in the Stage layout. */
  stageId: z.string().optional(),
});
export type FocusView = z.infer<typeof FocusView>;

export const BrowserState = z.object({
  url: z.string(),
  title: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  error: z.object({ code: z.number(), description: z.string(), url: z.string() }).nullable(),
});
export type BrowserState = z.infer<typeof BrowserState>;

export const ImageAttachment = z.object({
  mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  /** base64 without the data: prefix. ~10 MB cap. */
  dataBase64: z.string().max(14_000_000),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

export const Accent = z.enum(["glacier", "aurora", "nova", "ember", "bloom", "moss", "mono"]);
export type Accent = z.infer<typeof Accent>;

/** Appearance settings (§8.1, §8.11). */
export const Appearance = z.object({
  accent: Accent,
  density: z.enum(["comfortable", "compact"]),
  /** Interface size (whole window zoom). */
  uiScale: z.number().min(0.8).max(1.4),
  chatTextSize: z.number().min(12).max(20),
  cardStyle: z.enum(["solid", "glass"]),
  /** Card opacity in glass mode ("see-through"). */
  cardOpacity: z.number().min(0.5).max(1),
  grid: z.enum(["dots", "lines", "none"]),
  /** An image as a data: URL, or null. */
  wallpaper: z.string().max(12_000_000).nullable(),
  reduceMotion: z.boolean(),
  /** Chats take a wash of their agent's colour. */
  tintChats: z.boolean(),
  /** What the mouse wheel does on the canvas. */
  wheel: z.enum(["zoom", "pan"]),
});
export type Appearance = z.infer<typeof Appearance>;

/** "A new version is out" (GitHub Releases); nothing is downloaded. */
export const UpdateState = z.object({
  current: z.string(),
  available: z.object({ version: z.string(), url: z.string().url(), name: z.string(), publishedAt: z.string().nullable() }).nullable(),
  checkedAt: z.number().nullable(),
  /** Why the last check failed, if it did. */
  error: z.string().nullable(),
});
export type UpdateState = z.infer<typeof UpdateState>;

export const Prefs = z.object({
  onboarded: z.boolean(),
  notifyNeedsYou: z.boolean(),
  notifyFinished: z.boolean(),
  appearance: Appearance,
  /** Getting-started checklist steps done (§8.10 step 4), or null once dismissed. */
  checklist: z.array(z.enum(["send", "approve", "diff", "zoom", "palette"])).nullable(),
  /** Most chats one chat may have running through spawn_chat (§10.1 guardrails). */
  maxSpawned: z.number().int().min(1).max(20),
  /** Shortcut overrides by command id; an empty list unbinds the command. */
  keybindings: z.record(z.string(), z.array(z.string().max(40)).max(4)),
  /** Canvas or the tiled lattice. */
  layoutMode: z.enum(["canvas", "lattice"]),
  /** Mode new chats start in (Settings → Permissions, §8.11). */
  defaultPermissionMode: PermissionModeSchema,
  /** Command patterns that always need approval, even in Full-auto (§9.8 AC3). */
  alwaysAsk: z.array(z.string().trim().min(1).max(200)).max(100),
  /** Ask GitHub for a newer release now and then (Settings → General). */
  checkUpdates: z.boolean(),
  /** The release whose notice the user dismissed. */
  dismissedUpdate: z.string().nullable(),
});
export type Prefs = z.infer<typeof Prefs>;

const DiffHunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});

export const FileDiff = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  change: z.enum(["created", "modified", "deleted"]),
  hunks: z.array(DiffHunkSchema),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
});
export type FileDiff = z.infer<typeof FileDiff>;

export const FileStat = z.object({
  path: z.string(),
  change: z.enum(["created", "modified", "deleted"]),
  additions: z.number(),
  deletions: z.number(),
});
export type FileStat = z.infer<typeof FileStat>;

export const Decision = z.enum(["accepted", "reverted"]);
export const ReviewDecisions = z.record(
  z.string(),
  z.object({ file: Decision.optional(), hunks: z.record(z.string(), Decision).optional() }),
);
export type ReviewDecisions = z.infer<typeof ReviewDecisions>;

/** A finished turn that changed files (§9.5 AC1). */
export const ReviewItem = z.object({
  id: z.string(),
  chatId: z.string(),
  turnId: z.string(),
  summary: z.string(),
  files: z.array(FileStat),
  decisions: ReviewDecisions,
  createdAt: z.number(),
  reviewedAt: z.number().nullable(),
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/** One turn on a chat's timeline (§9.4 AC3). */
export const TimelineEntry = z.object({
  turnId: z.string(),
  seq: z.number(),
  userText: z.string(),
  startedAt: z.number(),
  files: z.array(z.string()),
  undone: z.boolean(),
  /** A checkpoint exists, so the turn can be undone/restored. */
  restorable: z.boolean(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const MergePreview = z.object({
  branch: z.string(),
  baseRef: z.string(),
  /** Commits the branch has that the base doesn't (after committing the agent's pending work). */
  ahead: z.number(),
  conflicts: z.array(z.string()),
  /** The main folder isn't on the base branch or has uncommitted changes, so merging there would be unsafe. */
  blocker: z.string().nullable(),
});
export type MergePreview = z.infer<typeof MergePreview>;

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
  flows: z.array(FlowInfo),
  edges: z.array(FlowEdge),
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
    res: z.object({
      version: z.string(),
      platform: z.string(),
      dataDir: z.string(),
      /** LATIS_DEMO_IN_PROJECTS=1 (tests): the demo agent can work in project folders. */
      demoInProjects: z.boolean(),
    }),
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
      /** Run in its own git worktree on a new `latis/<slug>` branch (§9.3 AC1). */
      isolate: z.boolean().optional(),
    }),
    /** `frame` is the project frame's new geometry when it grew to fit the chat. */
    res: z.object({ node: CanvasNode, chat: ChatSummary, frame: NodeGeometry.nullable() }),
  },
  "chat:transcript": { req: z.object({ chatId: z.string() }), res: Transcript },
  "chat:send": {
    req: z.object({ chatId: z.string(), text: z.string().min(1), images: z.array(ImageAttachment).max(8).optional() }),
    res: Turn,
  },
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
    req: z.object({ chatId: z.string(), text: z.string().min(1), images: z.array(ImageAttachment).max(8).optional() }),
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
  /** Saves (or with null, forgets) an agent's API key, encrypted with the OS keychain. */
  "agents:setApiKey": {
    req: z.object({ agentId: z.literal("claude-code"), key: z.string().trim().min(20).max(400).nullable() }),
    res: z.array(AgentInfo),
  },
  "agents:manifestErrors": { req: none, res: z.record(z.string(), z.string()) },
  /** Onboarding: a fresh folder under the data dir, opened as a project. */
  "project:createSandbox": {
    req: z.object({ canvasId: z.string(), x: z.number(), y: z.number() }),
    res: z.object({ project: Project, node: CanvasNode, existed: z.boolean() }),
  },
  /** Whether the project is a git repo and already has chats (to offer a worktree, §9.3 AC1, AC6). */
  "project:git": {
    req: z.object({ projectId: z.string() }),
    res: z.object({ isRepo: z.boolean(), chats: z.number(), gitMissing: z.boolean() }),
  },
  "project:initGit": { req: z.object({ projectId: z.string() }), res: ok },
  "chat:timeline": { req: z.object({ chatId: z.string() }), res: z.array(TimelineEntry) },
  /** Undo restores every file the turn changed; redo puts them back (§9.4 AC2). */
  "chat:undoTurn": { req: z.object({ chatId: z.string(), turnId: z.string() }), res: z.array(TimelineEntry) },
  "chat:redoTurn": { req: z.object({ chatId: z.string(), turnId: z.string() }), res: z.array(TimelineEntry) },
  /** Puts every file changed since this turn began back the way it was before it (§9.4 AC3). */
  "chat:restoreTo": { req: z.object({ chatId: z.string(), turnId: z.string() }), res: z.array(TimelineEntry) },
  "reviews:list": { req: none, res: z.array(ReviewItem) },
  "reviews:diff": { req: z.object({ reviewId: z.string() }), res: z.array(FileDiff) },
  /** Worktree branch (plus uncommitted work) vs. its base (§9.3 AC3). */
  "reviews:branchDiff": { req: z.object({ chatId: z.string() }), res: z.array(FileDiff) },
  /** Revert a file, or one hunk of it, in the working tree; the agent hears about it next turn. */
  "reviews:revert": { req: z.object({ reviewId: z.string(), path: z.string(), hunk: z.number().int().optional() }), res: ReviewItem },
  "reviews:accept": {
    req: z.object({ reviewId: z.string(), path: z.string().optional(), hunk: z.number().int().optional() }),
    res: ReviewItem,
  },
  "reviews:markReviewed": { req: z.object({ reviewId: z.string(), reviewed: z.boolean() }), res: ReviewItem },
  /** Sends feedback on a file or hunk back to the chat that made it, quoting the hunk (§9.5 AC4). */
  "reviews:askChanges": {
    req: z.object({ reviewId: z.string(), path: z.string(), hunk: z.number().int().optional(), feedback: z.string().min(1) }),
    res: ok,
  },
  /** Moves a chat into its own new worktree; its next message continues there (§8.5 cwd chip). */
  "chat:isolate": { req: z.object({ chatId: z.string() }), res: ChatSummary },
  "worktree:mergePreview": { req: z.object({ chatId: z.string() }), res: MergePreview },
  "worktree:merge": {
    req: z.object({ chatId: z.string(), mode: z.enum(["merge", "squash"]) }),
    res: z.object({ merged: z.boolean(), conflicts: z.array(z.string()) }),
  },
  /** `force` deletes unmerged commits; without it, unmerged branches are refused (§9.3 AC5). */
  "worktree:remove": {
    req: z.object({ chatId: z.string(), force: z.boolean() }),
    res: z.object({ removed: z.boolean(), unmerged: z.number() }),
  },
  /** Asks the chat's agent to bring its branch up to date with the base and resolve conflicts. */
  "worktree:askResolve": { req: z.object({ chatId: z.string(), files: z.array(z.string()) }), res: ok },
  "note:create": {
    req: z.object({ canvasId: z.string(), x: z.number(), y: z.number(), text: z.string().optional() }),
    res: CanvasNode,
  },
  /** A section label on the canvas ("Agents", "Website"…). Its text is changed with note:update. */
  "label:create": { req: z.object({ canvasId: z.string(), x: z.number(), y: z.number(), text: z.string().max(80) }), res: CanvasNode },
  "note:update": { req: z.object({ nodeId: z.string(), text: z.string().max(1_000_000) }), res: ok },
  /** Saves a note as a .md file the user picks. */
  "note:export": { req: z.object({ nodeId: z.string() }), res: ok },
  /** Soft delete (frames take their contents and project); files on disk are never touched (§9.1 AC3). */
  "canvas:delete": { req: z.object({ nodeIds: z.array(z.string()).min(1) }), res: z.object({ deleted: z.array(z.string()) }) },
  /** Brings deleted nodes back; returns the canvas so the renderer can merge them in. */
  "canvas:restore": { req: z.object({ nodeIds: z.array(z.string()).min(1) }), res: CanvasState },
  "canvas:deleted": {
    req: none,
    res: z.array(z.object({ nodeIds: z.array(z.string()), type: z.string(), title: z.string(), deletedAt: z.number() })),
  },
  "project:update": {
    req: z.object({ projectId: z.string(), name: z.string().min(1).max(80).optional(), color: z.string().optional() }),
    res: Project,
  },
  /** "Folder missing → Locate" (§9.1 AC4): pick where the folder went. `null` when cancelled. */
  "project:locate": { req: z.object({ projectId: z.string() }), res: Project.nullable() },
  /** Full-text search over chats and notes (§9.16). */
  "search:query": {
    req: z.object({ q: z.string().max(200) }),
    res: z.array(
      z.object({
        kind: z.enum(["user", "message", "note"]),
        chatId: z.string().nullable(),
        nodeId: z.string().nullable(),
        snippet: z.string(),
      }),
    ),
  },
  /** Files in a project (git-tracked and untracked-but-not-ignored, or a bounded walk), for the palette. */
  "project:files": { req: z.object({ projectId: z.string() }), res: z.array(z.string()) },
  "project:openFile": { req: z.object({ projectId: z.string(), path: z.string() }), res: ok },
  "lattice:get": { req: none, res: LatticeState },
  "lattice:set": { req: LatticeState, res: ok },
  "views:get": { req: none, res: z.array(FocusView) },
  "views:set": { req: z.array(FocusView).max(30), res: ok },
  /** Where the dock's browser area is, in window coordinates; hidden under dialogs and other dock tabs. */
  "browser:bounds": {
    req: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), visible: z.boolean() }),
    res: ok,
  },
  "browser:navigate": { req: z.object({ url: z.string().min(1).max(4000) }), res: BrowserState },
  "browser:nav": { req: z.enum(["back", "forward", "reload"]), res: ok },
  "browser:device": { req: z.enum(["responsive", "phone", "phone-landscape", "tablet", "tablet-landscape"]), res: ok },
  /** Local dev servers that are listening (§9.7 AC1). */
  "browser:detect": { req: none, res: z.array(z.number()) },
  /** Waits for a click on an element in the page; null if cancelled (§9.7 AC3). */
  "browser:pick": {
    req: none,
    res: z
      .object({
        html: z.string(),
        selector: z.string(),
        styles: z.record(z.string(), z.string()),
        imageBase64: z.string().nullable(),
        url: z.string(),
      })
      .nullable(),
  },
  /** Gives or takes the Workspace MCP tools (§10.2); applies from the chat's next message. */
  "chat:setWorkspaceTools": { req: z.object({ chatId: z.string(), on: z.boolean() }), res: ChatSummary },
  "chat:setConnections": { req: z.object({ chatId: z.string(), ids: z.array(z.string()).max(50) }), res: ChatSummary },
  "mcp:list": { req: none, res: z.array(McpConnection) },
  "mcp:save": { req: McpConnectionInput, res: McpConnection },
  "mcp:remove": { req: z.object({ id: z.string() }), res: ok },
  /** Reads other apps' MCP configs only when the user clicks Import (§9.15 AC2). */
  "mcp:importScan": { req: none, res: z.array(McpImportCandidate) },
  "mcp:import": { req: z.object({ path: z.string(), names: z.array(z.string()).min(1) }), res: z.array(McpConnection) },
  "skills:list": { req: z.object({ projectId: z.string().nullable() }), res: z.array(Skill) },
  "skills:openFolder": { req: none, res: ok },
  /** Copies a picked folder containing SKILL.md into the skills folder. */
  "skills:import": { req: none, res: Skill.nullable() },
  "skills:read": { req: z.object({ path: z.string() }), res: z.object({ body: z.string() }) },
  "conductor:setAgent": { req: z.object({ agentId: z.string() }), res: ChatSummary },
  "conductor:openPrefs": { req: none, res: ok },
  /** Send later (§9.10): at `fireAt`, or when the agent's limit resets (`onReset`). */
  "schedule:create": {
    req: z.object({
      chatId: z.string(),
      text: z.string().min(1),
      fireAt: z.number().optional(),
      onReset: z.boolean().optional(),
      repeatMs: z.number().int().min(60_000).nullable().optional(),
    }),
    res: ScheduledMessage,
  },
  "schedule:list": { req: none, res: z.array(ScheduledMessage) },
  "schedule:cancel": { req: z.object({ id: z.string() }), res: ok },
  "usage:get": { req: none, res: UsageState },
  "accounts:list": { req: none, res: AccountsState },
  /** Adds an account and opens its sign-in terminal. */
  "accounts:add": { req: z.object({ agentId: z.string(), label: z.string().min(1).max(40) }), res: AccountsState },
  "accounts:signIn": { req: z.object({ id: z.string() }), res: PtyInfo },
  /** Switches once the agent's running turns have finished (§9.12 AC3). */
  "accounts:switch": { req: z.object({ agentId: z.string(), accountId: z.string().nullable() }), res: AccountsState },
  "accounts:remove": { req: z.object({ id: z.string() }), res: AccountsState },
  /** The handoff brief for continuing a chat with another agent (§9.11 AC2). */
  "handoff:brief": { req: z.object({ chatId: z.string() }), res: z.object({ brief: z.string() }) },
  "handoff:start": {
    req: z.object({ chatId: z.string(), agentId: z.string(), brief: z.string().min(1) }),
    res: z.object({ node: CanvasNode, chat: ChatSummary, frame: NodeGeometry.nullable() }),
  },
  /** A card's bridge call (§12.2), relayed by the renderer after checking which frame sent it. */
  "card:call": {
    req: z.object({
      cardId: z.string(),
      method: z.enum(["data.get", "data.set", "data.list", "refresh", "sendToFlow", "exportPdf", "requestNetwork", "usage"]),
      args: z.array(z.unknown()).max(4),
    }),
    res: z.unknown(),
  },
  "card:library": { req: none, res: z.array(z.object({ id: z.string(), title: z.string(), description: z.string() })) },
  "card:create": { req: z.object({ canvasId: z.string(), starter: z.string(), x: z.number(), y: z.number() }), res: CanvasNode },
  "card:openFolder": { req: z.object({ cardId: z.string() }), res: ok },
  "flow:templates": { req: none, res: z.array(z.object({ id: z.string(), title: z.string(), description: z.string() })) },
  /** A flow from a template or a spec (§11.5, §11.6), laid out left to right at x, y. */
  "flow:create": {
    req: z.object({ canvasId: z.string(), template: z.string().optional(), spec: FlowSpec.optional(), x: z.number(), y: z.number() }),
    res: z.object({ flow: FlowInfo, nodes: z.array(CanvasNode), chats: z.array(ChatSummary), edges: z.array(FlowEdge) }),
  },
  "flow:start": { req: z.object({ flowId: z.string(), input: z.string().max(20_000).optional() }), res: FlowInfo },
  "flow:control": { req: z.object({ flowId: z.string(), action: z.enum(["pause", "resume", "stop"]) }), res: FlowInfo },
  "flow:approve": {
    req: z.object({
      flowId: z.string(),
      approvalId: z.string(),
      action: z.enum(["keep", "sendBack", "drop"]),
      feedback: z.string().max(4000).optional(),
      /** Keep with an edited text. */
      text: z.string().max(100_000).optional(),
    }),
    res: FlowInfo,
  },
  "flow:loop": { req: z.object({ flowId: z.string(), continue: z.boolean() }), res: FlowInfo },
  "flow:update": {
    req: z.object({
      flowId: z.string(),
      name: z.string().min(1).max(80).optional(),
      brief: z.string().max(4000).optional(),
      schedule: FlowSchedule.nullable().optional(),
      loopLimit: z.number().int().min(1).max(100).optional(),
    }),
    res: FlowInfo,
  },
  "flow:connect": {
    req: z.object({ flowId: z.string(), source: z.string(), target: z.string(), mode: EdgeMode.optional() }),
    res: FlowEdge,
  },
  "flow:edge": { req: z.object({ edgeId: z.string(), mode: EdgeMode.nullable() }), res: ok },
  "flow:setJob": { req: z.object({ nodeId: z.string(), job: z.string().max(4000) }), res: ok },
  "flow:setStart": { req: z.object({ nodeId: z.string(), input: z.string().max(20_000), oneTaskPerLine: z.boolean() }), res: ok },
  "prefs:get": { req: none, res: Prefs },
  "update:get": { req: none, res: UpdateState },
  "update:check": { req: none, res: UpdateState },
  "prefs:set": { req: Prefs.partial(), res: Prefs },
  /** Picks an image file for the canvas wallpaper; returns it as a data: URL, or null if cancelled. */
  "appearance:pickWallpaper": { req: none, res: z.string().nullable() },
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
  "reviews:changed": z.array(ReviewItem),
  "browser:state": BrowserState,
  "update:changed": UpdateState,
  "chat:timeline": z.object({ chatId: z.string(), entries: z.array(TimelineEntry) }),
  /** Main added or changed canvas items itself (the workspace tools, the Conductor). */
  "canvas:upsert": z.object({
    nodes: z.array(CanvasNode),
    chats: z.array(ChatSummary),
    projects: z.array(Project),
    /** Bring this node into view. */
    reveal: z.string().nullable(),
  }),
  "schedule:changed": z.array(ScheduledMessage),
  "flow:changed": FlowInfo,
  "flow:edges": z.object({ flowId: z.string(), edges: z.array(FlowEdge) }),
  /** A card's data changed outside the card (refresh, flows); the card is told to re-read it. */
  "card:data": z.object({ cardId: z.string() }),
  "usage:changed": UsageState,
  /** The workspace tools opened a focus view or asked for a canvas action. */
  "canvas:command": z.discriminatedUnion("type", [
    z.object({ type: z.literal("focus"), view: FocusView }),
    z.object({ type: z.literal("tidy") }),
  ]),
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
