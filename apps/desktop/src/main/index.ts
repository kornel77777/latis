import { app, BrowserWindow, crashReporter, dialog, nativeTheme, protocol, safeStorage, session, shell } from "electron";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  Appearance,
  AttentionItem,
  ChatSummary,
  FocusView,
  LatticeState,
  McpServerConfig,
  PermissionMode,
  Prefs,
  RequestResponse,
  SessionOptions,
  Theme,
} from "@latis/shared";
import { DEFAULT_ALWAYS_ASK } from "@latis/shared";
import conductorSystem from "../../resources/conductor/SYSTEM.md?raw";
import { AgentRegistry } from "./agents/registry";
import { shellEnv } from "./agents/shell-env";
import { SessionSupervisor } from "./agents/supervisor";
import { BrowserDock, detectDevPorts } from "./browser/browser-dock";
import { Changes } from "./git/changes";
import { git } from "./git/git";
import { EventCoalescer } from "./ipc/coalescer";
import { emit, registerHandlers } from "./ipc/register";
import { Notifier } from "./notify";
import { resolveDataDir } from "./paths";
import { openDb } from "./store/db";
import { EventLog } from "./store/event-log";
import { CHAT_SIZE, WorkspaceStore } from "./store/workspace";
import { PtyManager } from "./terminal/pty-manager";
import { Connections } from "./mcp/connections";
import { TOOL_TIMEOUT_SEC, WorkspaceMcpServer, type HookEndpoint } from "./mcp/server";
import { RELEASES_FEED, UpdateChecker } from "./updates";
import { LogFile } from "./logs";
import { exportWorkspace } from "./data-export";
import { diagnostics, issueUrl } from "./diagnostics";
import { WorkspaceService } from "./mcp/workspace";
import { Skills } from "./skills";
import { openLink } from "./security/links";
import { appUrlMatcher, lockDownPermissions } from "./security/permissions";
import { CARD_SIZE, Cards } from "./cards/cards";
import { gateCard, starters } from "./cards/library";
import { FlowEngine, nextRun } from "./flows/engine";
import { buildFlow } from "./flows/build";
import { TEMPLATES } from "./flows/templates";
import { buildBrief } from "./handoff";
import { Scheduler } from "./scheduler";
import { UsageMeter } from "./usage";
import { Accounts, HOME_ENV } from "./accounts";
import { agentEnv, setAccountEnv } from "./agents/shell-env";

const here = fileURLToPath(new URL(".", import.meta.url));
let win: BrowserWindow | null = null;

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
app.setPath("userData", join(dataDir, "electron"));
// Warnings, errors and crashes stay on this machine (docs/privacy.md).
const logs = new LogFile(join(dataDir, "logs"));
logs.install();
crashReporter.start({ uploadToServer: false });

// Cards get their own origin each (§12.1). Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([{ scheme: "card", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// One Latis per data folder. A second launch (Dock, Finder, Spotlight) brings the running window forward and
// stops right here, before it touches the shared database.
// Test runs use their own data folders and skip this; LATIS_SINGLE_INSTANCE=1 turns it back on (e2e).
const singleInstance = !process.env.LATIS_DATA_DIR || process.env.LATIS_SINGLE_INSTANCE === "1";
if (singleInstance && !app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
app.on("second-instance", () => {
  if (!win) {
    if (app.isReady()) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const store = new WorkspaceStore(openDb(join(dataDir, "latis.db")));
const eventLog = new EventLog(store);
const canvasId = store.ensureDefaultCanvas();

// Chats can't still be running after a restart; anything mid-flight goes back to idle.
for (const chat of store.loadCanvas(canvasId).chats) {
  if (chat.status === "working" || chat.status === "needs-you") store.updateChat(chat.id, { status: "idle" });
}

const accounts = new Accounts(store, dataDir);
setAccountEnv((agentId) => accounts.env(agentId));

const ptys = new PtyManager(() => import("node-pty"), {
  data: (id, data) => emit(win?.webContents, "pty:data", { id, data }),
  exit: (id, code) => emit(win?.webContents, "pty:exit", { id, code }),
});

// LATIS_REPLAY=<fixtures dir> swaps live agent CLIs for recorded streams (e2e tests; no network, no tokens).
// LATIS_CLAUDE_REPLAY=<fixtures/claude-code> is the M1 spelling and still works.
const replayRoot =
  process.env.LATIS_REPLAY ?? (process.env.LATIS_CLAUDE_REPLAY ? resolve(process.env.LATIS_CLAUDE_REPLAY, "..") : undefined);
// LATIS_UPDATE_FEED (tests) points the release check at a local server.
const updates = new UpdateChecker({
  current: app.getVersion(),
  feed: process.env.LATIS_UPDATE_FEED ?? RELEASES_FEED,
  ...(process.env.LATIS_UPDATE_FEED && { pagePrefix: new URL(process.env.LATIS_UPDATE_FEED).origin + "/" }),
  onChange: (s) => emit(win?.webContents, "update:changed", s),
});

/** The chat-view Claude's API key, encrypted with the OS keychain (decrypted once per launch). */
let claudeKey: string | null | undefined;
function claudeApiKey(): string | null {
  if (claudeKey !== undefined) return claudeKey;
  const saved = store.getSetting<string>("claudeApiKey");
  claudeKey = null;
  if (saved && safeStorage.isEncryptionAvailable()) {
    try {
      claudeKey = safeStorage.decryptString(Buffer.from(saved, "base64"));
    } catch (err) {
      console.warn("[agents] couldn't read the saved Anthropic API key", err);
    }
  }
  return claudeKey;
}

/**
 * Whether the chat-view Claude may run on the user's own Claude sign-in. Anthropic doesn't allow third-party
 * products to offer that, so release builds don't (DECISIONS 2026-10-26). Running from source does, and so does
 * a personal build made with LATIS_PERSONAL=1 (electron-builder writes `latisPersonal` into package.json).
 */
function claudeSubscriptionAllowed(): boolean {
  if (!app.isPackaged) return true;
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")).latisPersonal === true;
  } catch {
    return false;
  }
}

const agents = new AgentRegistry({
  dataDir,
  ptys,
  fakeRunnerPath: join(here, "fake-runner.js"),
  ...(replayRoot && { replayRoot }),
  hooks: (): Promise<HookEndpoint> => mcpReady.then(() => mcpServer),
  claudeApiKey,
  claudeSubscription: claudeSubscriptionAllowed(),
});

// LATIS_SKIP_ONBOARDING=1 (e2e) starts as if the first-run tour was done.
const DEFAULT_APPEARANCE: Appearance = {
  accent: "glacier",
  density: "comfortable",
  uiScale: 1,
  chatTextSize: 14,
  cardStyle: "solid",
  cardOpacity: 0.85,
  tintChats: true,
  wheel: "pan",
  grid: "dots",
  wallpaper: null,
  reduceMotion: false,
};
const DEFAULT_PREFS: Prefs = {
  onboarded: process.env.LATIS_SKIP_ONBOARDING === "1",
  notifyNeedsYou: true,
  notifyFinished: true,
  appearance: DEFAULT_APPEARANCE,
  // Tests skip the tour, and with it the checklist.
  checklist: process.env.LATIS_SKIP_ONBOARDING === "1" ? null : [],
  maxSpawned: 6,
  keybindings: {},
  // The lattice is where work happens; the canvas is the map. LATIS_LAYOUT=canvas starts on the canvas (most e2e specs).
  layoutMode: process.env.LATIS_LAYOUT === "canvas" ? "canvas" : "lattice",
  defaultPermissionMode: "auto-edit",
  alwaysAsk: DEFAULT_ALWAYS_ASK,
  checkUpdates: true,
  dismissedUpdate: null,
};
/** Once per data dir: move existing installs to the lattice and the cold accent (DECISIONS 2026-10-25). */
let designMigrated = false;
function migrateDesign() {
  if (designMigrated) return;
  designMigrated = true;
  if (store.getSetting<boolean>("designV2")) return;
  const saved = store.getSetting<Partial<Prefs>>("prefs");
  if (saved) {
    const next: Partial<Prefs> = { ...saved, layoutMode: DEFAULT_PREFS.layoutMode };
    if (saved.appearance?.accent === "aurora") next.appearance = { ...saved.appearance, accent: "glacier" };
    store.setSetting("prefs", next);
  }
  store.setSetting("designV2", true);
}
function prefs(): Prefs {
  migrateDesign();
  const saved = store.getSetting<Partial<Prefs>>("prefs") ?? {};
  // Before Settings → Permissions the default mode was its own setting.
  const legacyMode = store.getSetting<PermissionMode>("defaultPermissionMode");
  return {
    ...DEFAULT_PREFS,
    ...(legacyMode && { defaultPermissionMode: legacyMode }),
    ...saved,
    appearance: { ...DEFAULT_APPEARANCE, ...saved.appearance },
  };
}
/** Interface size is the window's zoom factor, so everything (canvas maths included) scales together. */
function applyUiScale() {
  win?.webContents.setZoomFactor(prefs().appearance.uiScale);
}

function sandboxDir(): string {
  const cwd = join(dataDir, "sandbox", randomUUID().slice(0, 8));
  mkdirSync(cwd, { recursive: true });
  if (!existsSync(join(cwd, "README.md"))) writeFileSync(join(cwd, "README.md"), "# Sandbox\n");
  return cwd;
}

let visibleChats = new Set<string>();
function focusChat(chatId: string) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  emit(win.webContents, "focus:chat", { chatId });
}

const notifier = new Notifier({
  window: () => win,
  prefs,
  chatTitle: (chatId) => store.getChat(chatId)?.title ?? "Chat",
  visible: () => visibleChats,
  focusChat,
  respond: (item: AttentionItem, allow: boolean) => {
    if (!item.refId) return focusChat(item.chatId);
    void supervisor.respond(item.chatId, item.refId, { kind: "permission", decision: allow ? "allow-once" : "deny" });
  },
});

const browserDock = new BrowserDock(
  () => win,
  (state) => emit(win?.webContents, "browser:state", state),
);

const changes = new Changes(store, dataDir, {
  reviews: (items) => emit(win?.webContents, "reviews:changed", items),
  timeline: (chatId, entries) => emit(win?.webContents, "chat:timeline", { chatId, entries }),
  note: (chatId, text) => supervisor.addNote(chatId, text),
  message: async (chatId, text) => {
    await supervisor.steer(chatId, text);
  },
});

const usage = new UsageMeter(store, (state) => emit(win?.webContents, "usage:changed", state));

const coalescer = new EventCoalescer((chatId, events) => emit(win?.webContents, "chat:events", { chatId, events }));
const supervisor = new SessionSupervisor(
  store,
  eventLog,
  agents.adapters,
  {
    event: (se) => coalescer.push(se),
    status: (chatId, status) => {
      coalescer.flush();
      emit(win?.webContents, "chat:status", { chatId, status });
    },
    updated: (chat) => emit(win?.webContents, "chat:updated", chat),
    queue: (chatId, queue) => emit(win?.webContents, "chat:queue", { chatId, queue }),
    turn: (turn) => emit(win?.webContents, "chat:turn", turn),
    attention: (items) => {
      notifier.badge(items);
      emit(win?.webContents, "attention:changed", items);
    },
    raised: (item) => notifier.raised(item),
    usage: (agentId, patch) => usage.update(agentId, patch),
  },
  {
    beforeTurn: (chatId, turnId) => changes.beforeTurn(chatId, turnId),
    afterTurn: (chatId, turnId, finalMessage) => changes.afterTurn(chatId, turnId, finalMessage),
  },
  {
    sessionOptions: (chat) => sessionOptions(chat),
    alwaysAsk: () => prefs().alwaysAsk,
    turnEnded: (chatId, status, final) => {
      try {
        flows.turnEnded(chatId, status, final);
      } catch (err) {
        console.error("[flows] routing a turn's output failed", err);
      }
    },
    expand: (chatId, text) => {
      const chat = store.getChat(chatId);
      const project = chat?.projectId ? store.getProject(chat.projectId) : undefined;
      return skills.expand(text, project && !project.folderMissing ? project.folderPath : null);
    },
  },
);
notifier.badge(store.openAttention());

// ── Orchestration (§9.14, §9.15, §10) ─────────────────────────────────────────

const skills = new Skills(join(dataDir, "skills"));
const connections = new Connections(store, {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (t) => safeStorage.encryptString(t),
  decrypt: (b) => safeStorage.decryptString(b),
});

const conductorDir = join(dataDir, "conductor");
const conductorPrefs = join(conductorDir, "AGENTS.md");
function ensureConductorDir() {
  mkdirSync(conductorDir, { recursive: true });
  if (!existsSync(conductorPrefs))
    writeFileSync(
      conductorPrefs,
      "# My preferences for the Conductor\n\nWrite anything the Conductor should always keep in mind: agents you prefer for which jobs, folders you work in, how you like summaries.\n",
    );
}

async function confirmDialog(message: string, detail: string, yes: string): Promise<boolean> {
  const options = { type: "question" as const, buttons: [yes, "Cancel"], defaultId: 1, cancelId: 1, message, detail };
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}

const cards = new Cards(store, join(dataDir, "cards"), { confirm: confirmDialog });

/** Renders a card to an A4 PDF with a read-only copy of its data (§12.2 exportPdf). */
async function exportCardPdf(cardId: string, theme: unknown) {
  const row = cards.row(cardId);
  if (!row) throw new Error("That card no longer exists.");
  const token = cards.snapshot(cardId, { theme, usage: usage.get() });
  const w = new BrowserWindow({ show: false, width: 794, height: 1123, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await w.loadURL(`card://${cardId}/index.html?snapshot=${token}`);
    await new Promise((r) => setTimeout(r, 400)); // let the card render its data
    const pdf = await w.webContents.printToPDF({ pageSize: "A4", printBackground: true });
    const options = {
      title: "Export card as PDF",
      defaultPath: `${row.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "card"}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return { saved: false };
    writeFileSync(r.filePath, pdf);
    return { saved: true };
  } finally {
    w.destroy();
  }
}

/** Puts a new card on the canvas and tells the renderer. */
function showCard(node: import("@latis/shared").CanvasNode, reveal = true) {
  emit(win?.webContents, "canvas:upsert", { nodes: [node], chats: [], projects: [], reveal: reveal ? node.id : null });
}

// ── Flows (§11) ───────────────────────────────────────────────────────────────

const flows = new FlowEngine({
  store,
  send: (chatId, text) => supervisor.enqueue(chatId, text),
  interrupt: (chatId) => supervisor.interrupt(chatId),
  busy: (chatId) => supervisor.busy(chatId),
  appendNote: (nodeId, markdown) => {
    const n = store.getNode(nodeId);
    if (!n) return;
    store.updateNodeData(nodeId, { text: `${String(n.data.text ?? "").trimEnd()}\n\n${markdown}\n` });
    emit(win?.webContents, "canvas:upsert", { nodes: [store.getNode(nodeId)!], chats: [], projects: [], reveal: null });
  },
  cardReceive: (nodeId, items, mode) => {
    const cardId = String(store.getNode(nodeId)?.data.cardId ?? "");
    if (!cards.row(cardId)) return;
    const key = mode === "gate" ? "inbox" : "items";
    const prev = (cards.dataGet(cardId, key) as unknown[] | null) ?? [];
    const add = items.map((i) => ({ id: i.id, text: i.text, label: i.label, at: Date.now() }));
    cards.dataSet(cardId, key, [...prev, ...add].slice(-200));
    emit(win?.webContents, "card:data", { cardId });
  },
  changed: (flowId) => {
    const info = store.flowInfo(flowId);
    if (info) emit(win?.webContents, "flow:changed", info);
  },
});

async function readyAgents(): Promise<string[]> {
  const list = await agents.list();
  const ok = (id: string) => list.some((a) => a.id === id && a.installed && a.signedIn && (a.kind === "structured" || agents.isHooked(id)));
  // Claude Code in a terminal comes after the chat-view agents: it works, but its tile is a terminal.
  const order = ["claude-code", "codex", "gemini", "terminal:claude", ...list.map((a) => a.id)];
  const ids = [...new Set(order)].filter((id) => ok(id) && (id !== "fake" || process.env.LATIS_DEMO_IN_PROJECTS === "1"));
  // The demo agent stands in for everything in tests.
  return process.env.LATIS_FLOW_AGENT ? [process.env.LATIS_FLOW_AGENT] : ids;
}

function createFlowFrom(spec: import("@latis/shared").FlowSpec, x: number, y: number) {
  return buildFlow(
    {
      store,
      dataDir,
      canvasId,
      readyAgents,
      defaultMode: () => prefs().defaultPermissionMode,
      createCard: ({ title, gate, fields, x: cx, y: cy, parentId }) => {
        const g = gateCard(gate);
        if (!g) throw new Error(`There's no "${gate}" gate card.`);
        const node = cards.create({ canvasId, title, html: g.html, files: g.files, gate, x: cx, y: cy, parentId });
        if (fields) cards.dataSet(String(node.data.cardId), "fields", fields);
        return node;
      },
    },
    spec,
    x,
    y,
  );
}

const workspace = new WorkspaceService({
  store,
  canvasId,
  supervisor,
  agents: {
    available: async () =>
      (await agents.list()).filter(
        (a) => a.installed && a.kind === "structured" && (a.id !== "fake" || process.env.LATIS_DEMO_IN_PROJECTS === "1"),
      ),
  },
  changes,
  openProject: (folder, x, y) => {
    const r = openProject(canvasId, folder, x, y);
    return r;
  },
  confirm: async (message, detail) => {
    const options = { type: "question" as const, buttons: ["Close it", "Keep it"], defaultId: 1, cancelId: 1, message, detail };
    const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return r.response === 0;
  },
  ui: {
    upsert: (payload) => emit(win?.webContents, "canvas:upsert", payload),
    focus: (view) => emit(win?.webContents, "canvas:command", { type: "focus", view }),
    tidy: () => emit(win?.webContents, "canvas:command", { type: "tidy" }),
  },
  maxSpawned: () => prefs().maxSpawned,
  createFlow: async (spec, x, y) => {
    const r = await createFlowFrom(spec, x, y);
    emit(win?.webContents, "canvas:upsert", { nodes: r.nodes, chats: r.chats, projects: [], reveal: r.nodes[0]!.id });
    emit(win?.webContents, "flow:changed", r.flow);
    emit(win?.webContents, "flow:edges", { flowId: r.flow.id, edges: r.edges });
    return r.flow;
  },
  startFlow: (flowId, input) => flows.start(flowId, input, "the Conductor"),
  cards: {
    create: (input) => {
      const node = cards.create({ canvasId, ...input });
      showCard(node);
      return node;
    },
    update: (id, patch) => {
      const node = cards.update(id, patch);
      showCard(node, false);
      return node;
    },
  },
});
const mcpServer = new WorkspaceMcpServer(workspace);
const mcpReady = mcpServer.start().catch((err: unknown) => console.error("[mcp] the workspace server didn't start", err));
const shimPath = join(here, "latis-mcp.js");

/** Latis's own server for a chat: HTTP where the agent takes it, otherwise the stdio shim. */
function latisServer(chat: ChatSummary): McpServerConfig {
  const token = mcpServer.tokenFor(chat.id);
  const http = chat.agentId === "claude-code" || chat.agentId === "terminal:claude" || chat.agentId === "codex";
  return http
    ? {
        name: "latis",
        transport: "http",
        url: mcpServer.url,
        headers: { Authorization: `Bearer ${token}` },
        toolTimeoutSec: TOOL_TIMEOUT_SEC,
        trusted: true,
      }
    : {
        name: "latis",
        transport: "stdio",
        command: process.execPath,
        args: [shimPath],
        env: { ELECTRON_RUN_AS_NODE: "1", LATIS_MCP_URL: mcpServer.url, LATIS_MCP_TOKEN: token },
        toolTimeoutSec: TOOL_TIMEOUT_SEC,
        trusted: true,
      };
}

const TOOLS_NOTE =
  "You can see and coordinate the other chats in Latis through the `latis` MCP tools (list_chats, read_chat, spawn_chat, send_message, wait_for_chats, get_diff, create_note, focus). Use them when the user asks you to work with other chats or agents.";

async function sessionOptions(chat: ChatSummary): Promise<Partial<SessionOptions>> {
  const adapter = agents.get(chat.agentId);
  if (!adapter?.capabilities.mcp) return {};
  await mcpReady;
  const conductor = chat.role === "conductor";
  const servers = [...(conductor || chat.workspaceTools ? [latisServer(chat)] : []), ...connections.configsFor(chat.connections)];
  let instructions: string | undefined;
  if (conductor) {
    ensureConductorDir();
    const mine = readFileSync(conductorPrefs, "utf8").trim();
    instructions = `${conductorSystem}\n\n# The user's preferences (AGENTS.md)\n\n${mine}`;
  } else if (chat.workspaceTools) instructions = TOOLS_NOTE;
  return {
    ...(servers.length && { mcpServers: servers }),
    ...(instructions && { systemPromptAppend: instructions }),
    // Claude Code's own limit on a tool call; wait_for_chats can take minutes.
    env: { MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_SEC * 1000) },
  };
}

const scheduler = new Scheduler({
  store,
  deliver: (chatId, text) => supervisor.enqueue(chatId, text),
  note: (chatId, text) => supervisor.addNote(chatId, text),
  changed: (list) => emit(win?.webContents, "schedule:changed", list),
});

/** Opens an account's sign-in in the dock, with the CLI pointed at the account's folder. */
async function signInAccount(id: string) {
  const acc = accounts.get(id);
  const a = acc && agents.get(acc.agentId);
  if (!acc || !a?.login) throw new Error("This agent signs in inside its own terminal.");
  const { pty } = await a.login();
  const info = await dockTerminal({
    ...pty,
    cwd: homedir(),
    title: `Sign in · ${a.displayName} · ${acc.label}`,
    projectId: null,
    chatId: null,
    env: { ...(await shellEnv()), [HOME_ENV[acc.agentId]!]: acc.home },
  });
  const unsub = ptys.subscribe(info.id, (e) => {
    if (e.exit === undefined) return;
    unsub();
    void agents.list(true).then((list) => emit(win?.webContents, "agents:changed", list));
  });
  return info;
}

/** Asks agents that can tell without spending tokens how much of their usage is left (Codex). */
async function probeUsage() {
  // Recorded agents (tests) have no account to ask.
  if (replayRoot) return;
  for (const a of await agents.list()) {
    const adapter = agents.get(a.id);
    if (!a.installed || !a.signedIn || !adapter?.usage) continue;
    try {
      usage.update(a.id, { windows: await adapter.usage() });
    } catch (err) {
      console.warn(`[usage] ${a.id} didn't report usage`, err instanceof Error ? err.message : err);
    }
  }
}

const CONDUCTOR_ORDER = ["claude-code", "codex", "gemini", "terminal:claude"];

/** The pinned Conductor chat (§10.2), created once at the canvas's top left. */
async function ensureConductor() {
  if (process.env.LATIS_SKIP_CONDUCTOR === "1" || store.conductor()) return;
  const list = await agents.list();
  const forced = process.env.LATIS_CONDUCTOR_AGENT;
  const ready = CONDUCTOR_ORDER.map((id) => list.find((a) => a.id === id && a.installed && a.signedIn)).find(Boolean);
  const agentId = forced ?? ready?.id ?? "claude-code";
  if (store.conductor()) return;
  ensureConductorDir();
  const top = store.loadCanvas(canvasId).nodes.filter((n) => !n.parentId);
  const x = top.length ? Math.min(...top.map((n) => n.x)) - CHAT_SIZE.w - 80 : 0;
  const y = top.length ? Math.min(...top.map((n) => n.y)) : 0;
  const created = store.createChatNode({
    canvasId,
    projectId: null,
    parentId: null,
    x,
    y,
    agentId,
    model: agentId === "fake" ? "demo-1" : null,
    reasoning: null,
    permissionMode: prefs().defaultPermissionMode,
    cwd: conductorDir,
    title: "Conductor",
    role: "conductor",
  });
  store.updateChat(created.chat.id, { titleLocked: true });
  emit(win?.webContents, "canvas:upsert", { nodes: [created.node], chats: [store.getChat(created.chat.id)!], projects: [], reveal: null });
}

/** Workspace tools and connections are fixed when an agent starts, so they apply from the next message. */
async function restartForOptions(chatId: string) {
  if (supervisor.busy(chatId)) throw new Error("Wait for the current turn to finish, then try again.");
  await supervisor.release(chatId);
  const chat = store.getChat(chatId)!;
  emit(win?.webContents, "chat:updated", chat);
  return chat;
}

function applyTheme(theme: Theme) {
  nativeTheme.themeSource = theme;
}
applyTheme(store.getSetting<Theme>("theme") ?? "dark");

/** Opens a terminal in the dock; it tells the renderer so the dock shows it. */
async function dockTerminal(spec: {
  file: string;
  args: string[];
  cwd: string;
  title: string;
  projectId: string | null;
  chatId: string | null;
  env?: NodeJS.ProcessEnv;
}) {
  const info = await ptys.create({ ...spec, env: spec.env ?? (await shellEnv()), place: "dock" });
  emit(win?.webContents, "pty:opened", info);
  return info;
}

const FILE_LIMIT = 5000;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "out", "build", "target", ".venv", "__pycache__"]);

/** A project's files for the palette: git's view when it's a repo, else a bounded walk. */
async function listFiles(folder: string): Promise<string[]> {
  try {
    const { stdout } = await git(folder, ["ls-files", "--cached", "--others", "--exclude-standard"]);
    return stdout.split("\n").filter(Boolean).slice(0, FILE_LIMIT);
  } catch {
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= FILE_LIMIT) return;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), `${rel}${e.name}/`);
        } else out.push(`${rel}${e.name}`);
      }
    };
    walk(folder, "");
    return out;
  }
}

function userShell(): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: process.env.COMSPEC ?? "powershell.exe", args: [] };
  return { file: process.env.SHELL || "/bin/zsh", args: ["-l"] };
}

function openProject(id: string, folder: string, x: number, y: number) {
  const existing = store.findProjectByFolder(folder);
  if (existing) {
    const node = store.loadCanvas(id).nodes.find((n) => n.id === existing.frameNodeId);
    if (node) return { project: existing, node, existed: true };
  }
  return { ...store.createProject({ canvasId: id, folderPath: folder, x, y }), existed: false };
}

registerHandlers({
  "app:info": () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir,
    demoInProjects: process.env.LATIS_DEMO_IN_PROJECTS === "1",
  }),
  "canvas:load": () => store.loadCanvas(canvasId),
  "canvas:saveNodes": ({ nodes }) => {
    store.saveNodeGeometry(nodes);
    return { ok: true };
  },
  "canvas:saveViewport": ({ canvasId: id, viewport }) => {
    store.saveViewport(id, viewport);
    return { ok: true };
  },
  "agents:list": ({ refresh }) => agents.list(refresh),
  "agents:models": async ({ agentId }) => {
    const a = agents.get(agentId);
    if (!a) throw new Error(`unknown agent ${agentId}`);
    return a.listModels();
  },
  "agents:login": async ({ agentId }) => {
    const a = agents.get(agentId);
    if (!a?.login) throw new Error("This agent signs in inside its own terminal.");
    const { pty } = await a.login();
    const info = await dockTerminal({
      ...pty,
      cwd: homedir(),
      title: `Sign in · ${a.displayName}`,
      projectId: null,
      chatId: null,
      // Signs in the active account (§9.12 AC3). Both Claudes share one CLI home.
      env: await agentEnv(agentId === "terminal:claude" ? "claude-code" : agentId),
    });
    // Re-check once the sign-in terminal closes, so the agent shows as signed in.
    const unsub = ptys.subscribe(info.id, (e) => {
      if (e.exit === undefined) return;
      unsub();
      void agents.list(true).then((list) => emit(win?.webContents, "agents:changed", list));
    });
    return info;
  },
  "agents:setApiKey": async ({ key }) => {
    if (key && !safeStorage.isEncryptionAvailable()) throw new Error("There's no keychain to keep the key in, so Latis won't save it.");
    if (key) store.setSetting("claudeApiKey", safeStorage.encryptString(key).toString("base64"));
    else store.setSetting("claudeApiKey", null);
    claudeKey = key;
    const list = await agents.list(true);
    emit(win?.webContents, "agents:changed", list);
    return list;
  },
  "agents:openFolder": async () => {
    mkdirSync(agents.agentsDir, { recursive: true });
    return { ok: (await shell.openPath(agents.agentsDir)) === "" };
  },
  "agents:manifestErrors": () => agents.manifestErrors,
  "project:openFolder": async ({ canvasId: id, x, y }) => {
    const options = {
      title: "Open a project folder",
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
    };
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const folder = picked.filePaths[0];
    if (picked.canceled || !folder) return null;
    return openProject(id, folder, x, y);
  },
  "project:createSandbox": ({ canvasId: id, x, y }) => {
    const folder = join(dataDir, "projects", `sandbox-${randomUUID().slice(0, 6)}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "README.md"), "# Sandbox\n\nA scratch project for trying agents. Safe to delete.\n");
    return openProject(id, folder, x, y);
  },
  "project:reveal": async ({ projectId }) => {
    const p = store.getProject(projectId);
    if (!p) return { ok: false };
    return { ok: (await shell.openPath(p.folderPath)) === "" };
  },
  "chat:create": async ({ canvasId: id, projectId, agentId, x, y, model, reasoning, permissionMode, isolate }) => {
    if (!agents.get(agentId)) throw new Error(`unknown agent ${agentId}`);
    const project = projectId ? store.getProject(projectId) : undefined;
    if (projectId && !project) throw new Error("That project no longer exists.");
    if (!project && agentId !== "fake") throw new Error("Open a project folder first, then start the chat inside it.");
    const place = project ? store.placeInFrame(project.frameNodeId) : { x, y, frame: null };
    const agentName = agents.get(agentId)!.displayName;
    const own = isolate && project ? await changes.createWorktree(project.id, project.folderPath, agentName) : null;
    const created = store.createChatNode({
      canvasId: id,
      projectId: project?.id ?? null,
      parentId: project?.frameNodeId ?? null,
      x: place.x,
      y: place.y,
      agentId,
      model: model ?? (agentId === "fake" ? "demo-1" : null),
      reasoning: reasoning ?? null,
      permissionMode: permissionMode ?? prefs().defaultPermissionMode,
      cwd: own?.cwd ?? project?.folderPath ?? sandboxDir(),
      worktreeId: own?.worktreeId ?? null,
      title: agentId === "fake" ? "Demo chat" : agents.isTerminal(agentId) ? agents.get(agentId)!.displayName : "New chat",
    });
    return { ...created, frame: place.frame };
  },
  "chat:transcript": ({ chatId }) => {
    eventLog.flush();
    return store.transcript(chatId);
  },
  "chat:send": ({ chatId, text, images }) => supervisor.send(chatId, text, images),
  "chat:steer": ({ chatId, text, images }) => supervisor.steer(chatId, text, images),
  "chat:queue": ({ chatId }) => supervisor.queueOf(chatId),
  "chat:queueEdit": ({ chatId, id, text }) => supervisor.editQueued(chatId, id, text),
  "chat:queueRemove": ({ chatId, id }) => supervisor.removeQueued(chatId, id),
  "chat:sendNow": async ({ chatId, id }) => ({ ok: await supervisor.sendNow(chatId, id) }),
  "chat:respond": async ({ chatId, requestId, response }) => ({
    ok: await supervisor.respond(chatId, requestId, response satisfies RequestResponse),
  }),
  "chat:interrupt": async ({ chatId }) => ({ ok: await supervisor.interrupt(chatId) }),
  "chat:restart": async ({ chatId }) => ({ ok: await supervisor.restart(chatId) }),
  "chat:setOptions": ({ chatId, ...patch }) => supervisor.setOptions(chatId, patch),
  "chat:reveal": async ({ chatId, path }) => {
    const chat = store.getChat(chatId);
    if (!chat) return { ok: false };
    // Only paths inside the chat's folder can be opened from the renderer.
    const target = path ? resolve(chat.cwd, path) : chat.cwd;
    if (target !== chat.cwd && !target.startsWith(chat.cwd + sep)) return { ok: false };
    return { ok: (await shell.openPath(target)) === "" };
  },
  "chat:openTerminal": async ({ chatId }) => {
    const chat = store.getChat(chatId);
    const a = chat && agents.get(chat.agentId);
    if (!chat || !a) throw new Error("That chat no longer exists.");
    // One process per conversation: the structured session stops before the CLI resumes it.
    await supervisor.release(chatId);
    const native = store.nativeSessionId(chatId);
    const spec = a.terminalCommand({
      cwd: chat.cwd,
      permissionMode: chat.permissionMode,
      alwaysAsk: [],
      ...(native && { nativeSessionId: native }),
    });
    return dockTerminal({ ...spec, title: `${a.displayName} · ${chat.title}`, projectId: chat.projectId, chatId });
  },
  "chat:attachTerminal": async ({ chatId }) => {
    const ptyId = await supervisor.attachTerminal(chatId, (id) => ptys.get(id)?.running ?? false);
    return ptys.get(ptyId)!;
  },
  "chat:seen": ({ chatId }) => {
    supervisor.seen(chatId);
    return { ok: true };
  },
  "attention:list": () => store.openAttention(),
  "attention:dismiss": ({ id }) => {
    supervisor.dismiss(id);
    return { ok: true };
  },
  "ui:visibleChats": ({ chatIds }) => {
    visibleChats = new Set(chatIds);
    return { ok: true };
  },
  "pty:create": async ({ projectId }) => {
    const project = projectId ? store.getProject(projectId) : undefined;
    const cwd = project && !project.folderMissing ? project.folderPath : homedir();
    const sh = userShell();
    return dockTerminal({ ...sh, cwd, title: project?.name ?? "Terminal", projectId: project?.id ?? null, chatId: null });
  },
  "pty:list": () => ptys.list(),
  "pty:snapshot": ({ id }) => ({ data: ptys.snapshot(id) }),
  "pty:write": ({ id, data }) => ({ ok: ptys.write(id, data) }),
  "pty:resize": ({ id, cols, rows }) => ({ ok: ptys.resize(id, cols, rows) }),
  "pty:kill": ({ id }) => ({ ok: ptys.kill(id) }),
  "project:git": async ({ projectId }) => {
    const p = store.getProject(projectId);
    if (!p) throw new Error("That project no longer exists.");
    return { ...(await changes.projectGit(p.folderPath)), chats: store.chatsInProject(projectId) };
  },
  "project:initGit": async ({ projectId }) => {
    const p = store.getProject(projectId);
    if (!p) throw new Error("That project no longer exists.");
    await changes.initGit(p.folderPath);
    return { ok: true };
  },
  "chat:timeline": ({ chatId }) => changes.timeline(chatId),
  "chat:undoTurn": ({ chatId, turnId }) => changes.undo(chatId, turnId),
  "chat:redoTurn": ({ chatId, turnId }) => changes.redo(chatId, turnId),
  "chat:restoreTo": ({ chatId, turnId }) => changes.restoreTo(chatId, turnId),
  "reviews:list": () => store.listReviews(),
  "reviews:diff": ({ reviewId }) => changes.reviewDiff(reviewId),
  "reviews:branchDiff": ({ chatId }) => changes.branchDiff(chatId),
  "reviews:revert": ({ reviewId, path, hunk }) => changes.revert(reviewId, path, hunk),
  "reviews:accept": ({ reviewId, path, hunk }) => changes.accept(reviewId, path, hunk),
  "reviews:markReviewed": ({ reviewId, reviewed }) => changes.markReviewed(reviewId, reviewed),
  "reviews:askChanges": async ({ reviewId, path, hunk, feedback }) => {
    await changes.askChanges(reviewId, path, hunk, feedback);
    return { ok: true };
  },
  "chat:isolate": async ({ chatId }) => {
    const chat = store.getChat(chatId);
    const project = chat?.projectId ? store.getProject(chat.projectId) : undefined;
    if (!chat || !project) throw new Error("Only chats in a project can have their own copy.");
    if (chat.worktree && !chat.worktree.removed) return chat;
    // The agent restarts in the copy (resuming its conversation) with the next message.
    await supervisor.release(chatId);
    const own = await changes.createWorktree(project.id, project.folderPath, agents.get(chat.agentId)?.displayName ?? "chat");
    store.setChatCwd(chatId, own.cwd, own.worktreeId);
    const updated = store.getChat(chatId)!;
    emit(win?.webContents, "chat:updated", updated);
    return updated;
  },
  "worktree:mergePreview": ({ chatId }) => changes.mergePreview(chatId),
  "worktree:merge": ({ chatId, mode }) => changes.merge(chatId, mode),
  "worktree:remove": async ({ chatId, force }) => {
    // The agent process runs inside the worktree; stop it before the folder goes away.
    await supervisor.release(chatId);
    const r = await changes.removeWorktree(chatId, force);
    const chat = store.getChat(chatId);
    if (chat) emit(win?.webContents, "chat:updated", chat);
    return r;
  },
  "worktree:askResolve": async ({ chatId, files }) => {
    await changes.askResolve(chatId, files);
    return { ok: true };
  },
  "note:create": ({ canvasId: id, x, y, text }) =>
    store.createNote({ canvasId: id, projectId: null, parentId: null, x, y, ...(text !== undefined && { text }) }),
  "label:create": ({ canvasId: id, x, y, text }) =>
    store.createNode({ canvasId: id, parentId: null, type: "label", x, y, w: 260, h: 64, data: { text } }),
  "note:update": ({ nodeId, text }) => {
    store.updateNodeData(nodeId, { text });
    return { ok: true };
  },
  "note:export": async ({ nodeId }) => {
    const node = store.getNode(nodeId);
    if (!node) throw new Error("That note no longer exists.");
    const text = String(node.data.text ?? "");
    const first =
      text
        .split("\n")
        .find((l) => l.trim())
        ?.replace(/^#+\s*/, "")
        .trim() || "note";
    const options = {
      title: "Export note",
      defaultPath: `${first.replace(/[^\w\- ]+/g, "").slice(0, 60) || "note"}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return { ok: false };
    writeFileSync(r.filePath, text.endsWith("\n") ? text : `${text}\n`);
    return { ok: true };
  },
  "canvas:delete": async ({ nodeIds }) => {
    const deleted = store.softDelete(nodeIds);
    // Deleted chats stop their agents; their Inbox and Review items disappear with them.
    const chatIds = deleted.flatMap((id) => {
      const n = store.getNode(id);
      return n?.type === "chat" && typeof n.data.chatId === "string" ? [n.data.chatId] : [];
    });
    await Promise.all(chatIds.map((c) => supervisor.release(c)));
    chatIds.forEach((c) => scheduler.forgetChat(c));
    emit(win?.webContents, "attention:changed", store.openAttention());
    emit(win?.webContents, "reviews:changed", store.listReviews());
    return { deleted };
  },
  "canvas:restore": ({ nodeIds }) => {
    store.restore(nodeIds);
    emit(win?.webContents, "attention:changed", store.openAttention());
    emit(win?.webContents, "reviews:changed", store.listReviews());
    return store.loadCanvas(canvasId);
  },
  "canvas:deleted": () => store.deletedItems(canvasId),
  "project:update": ({ projectId, ...patch }) => store.updateProject(projectId, patch),
  "project:locate": async ({ projectId }) => {
    const p = store.getProject(projectId);
    if (!p) throw new Error("That project no longer exists.");
    const options = { title: `Where is ${p.name} now?`, properties: ["openDirectory"] as "openDirectory"[] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const folder = r.filePaths[0];
    if (r.canceled || !folder) return null;
    return store.updateProject(projectId, { folderPath: folder });
  },
  "search:query": ({ q }) => store.search(q),
  "project:files": async ({ projectId }) => {
    const p = store.getProject(projectId);
    if (!p || p.folderMissing) return [];
    return listFiles(p.folderPath);
  },
  "project:openFile": async ({ projectId, path }) => {
    const p = store.getProject(projectId);
    if (!p) return { ok: false };
    const target = resolve(p.folderPath, path);
    if (!target.startsWith(p.folderPath + sep)) return { ok: false };
    return { ok: (await shell.openPath(target)) === "" };
  },
  "lattice:get": () => store.getSetting<LatticeState>("lattice") ?? { root: null, projectId: null, hidden: [] },
  "lattice:set": (state) => {
    store.setSetting("lattice", state);
    return { ok: true };
  },
  "views:get": () => store.getSetting<FocusView[]>("focusViews") ?? [],
  "views:set": (views) => {
    store.setSetting("focusViews", views);
    return { ok: true };
  },
  "browser:bounds": ({ visible, ...b }) => {
    browserDock.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, visible);
    return { ok: true };
  },
  "browser:navigate": async ({ url }) => {
    await browserDock.navigate(url);
    return browserDock.state();
  },
  "browser:nav": (action) => {
    if (action === "back") browserDock.back();
    else if (action === "forward") browserDock.forward();
    else browserDock.reload();
    return { ok: true };
  },
  "browser:device": async (device) => {
    await browserDock.setDevice(device);
    return { ok: true };
  },
  "browser:detect": () => detectDevPorts(),
  "browser:pick": () => browserDock.pick(),
  "schedule:create": ({ chatId, text, fireAt, onReset, repeatMs }) => {
    const chat = store.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    let at = fireAt;
    if (onReset) {
      const resets = usage.resetsAt(chat.agentId);
      if (!resets) throw new Error("Latis doesn't know when this agent's limit resets. Pick a time instead.");
      // A minute of slack: limits reset on the provider's clock.
      at = Date.parse(resets) + 60_000;
    }
    if (at === undefined) throw new Error("Pick when to send it.");
    return scheduler.add({ chatId, text, fireAt: at, repeatMs: repeatMs ?? null, onReset: Boolean(onReset) });
  },
  "schedule:list": () => scheduler.list(),
  "schedule:cancel": ({ id }) => ({ ok: scheduler.cancel(id) }),
  "usage:get": () => usage.get(),
  "accounts:list": () => accounts.state(),
  "accounts:add": async ({ agentId, label }) => {
    const acc = accounts.add(agentId, label);
    await signInAccount(acc.id);
    return accounts.state();
  },
  "accounts:signIn": ({ id }) => signInAccount(id),
  "accounts:switch": async ({ agentId, accountId }) => {
    // §9.12 AC3: running turns finish on the old account first.
    while (store.liveChats().some((c) => c.agentId === agentId && supervisor.busy(c.id))) await new Promise((r) => setTimeout(r, 1000));
    accounts.setActive(agentId, accountId);
    await Promise.all(store.liveChats().flatMap((c) => (c.agentId === agentId ? [supervisor.release(c.id)] : [])));
    // The new account's usage is unknown until it reports.
    usage.update(agentId, { windows: [], limited: null });
    emit(win?.webContents, "agents:changed", await agents.list(true));
    void probeUsage();
    return accounts.state();
  },
  "accounts:remove": async ({ id }) => {
    const acc = accounts.get(id);
    if (acc && accounts.state().active[acc.agentId] === id) {
      accounts.setActive(acc.agentId, null);
      emit(win?.webContents, "agents:changed", await agents.list(true));
    }
    accounts.remove(id);
    return accounts.state();
  },
  "handoff:brief": async ({ chatId }) => {
    const chat = store.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    eventLog.flush();
    const files = await changes.chatDiff(chatId).catch(() => []);
    return { brief: buildBrief(store, chat, agents.get(chat.agentId)?.displayName ?? chat.agentId, files) };
  },
  "handoff:start": async ({ chatId, agentId, brief }) => {
    const from = store.getChat(chatId);
    if (!from) throw new Error("That chat no longer exists.");
    const a = agents.get(agentId);
    if (!a || (agents.isTerminal(agentId) && !agents.isHooked(agentId))) throw new Error("Pick an agent Latis can chat with.");
    if (agentId === from.agentId) throw new Error("Pick a different agent to continue with.");
    const project = from.projectId ? store.getProject(from.projectId) : undefined;
    const r = store.absoluteRect(from.nodeId);
    const place = project ? store.placeInFrame(project.frameNodeId) : { x: (r?.x ?? 0) + (r?.w ?? 0) + 60, y: r?.y ?? 0, frame: null };
    const created = store.createChatNode({
      canvasId,
      projectId: project?.id ?? null,
      parentId: project?.frameNodeId ?? null,
      x: place.x,
      y: place.y,
      agentId,
      model: agentId === "fake" ? "demo-1" : null,
      reasoning: null,
      permissionMode: from.permissionMode,
      cwd: from.cwd,
      // Same folder or worktree: the work continues where it is (§9.11 AC3).
      worktreeId: from.worktree && !from.worktree.removed ? from.worktree.id : null,
      title: `${from.title} (cont.)`.slice(0, 120),
      continuedFrom: from.id,
    });
    store.updateChat(created.chat.id, { titleLocked: true });
    await supervisor.send(created.chat.id, brief);
    return { ...created, chat: store.getChat(created.chat.id)!, frame: place.frame };
  },
  "card:call": async ({ cardId, method, args }) => {
    if (!cards.row(cardId)) throw new Error("That card no longer exists.");
    switch (method) {
      case "data.get":
        return cards.dataGet(cardId, String(args[0]));
      case "data.set":
        cards.dataSet(cardId, String(args[0]), args[1]);
        return null;
      case "data.list":
        return cards.dataList(cardId);
      case "refresh": {
        const r = await cards.refresh(cardId);
        emit(win?.webContents, "card:data", { cardId });
        return r;
      }
      case "requestNetwork": {
        const ok = await cards.requestNetwork(cardId, args[0]);
        // The card reloads so its new CSP applies.
        if (ok) showCard(cards.update(cardId, {}), false);
        return ok;
      }
      case "usage":
        return usage.get();
      case "exportPdf":
        return exportCardPdf(cardId, args[0]);
      case "sendToFlow": {
        const row = cards.row(cardId)!;
        if (!row.gate || row.gate === "results") throw new Error("Only a flow's gate cards can send items to the flow.");
        flows.fromCard(row.nodeId, args[0]);
        return null;
      }
    }
  },
  "card:library": () => starters.map(({ id, title, description }) => ({ id, title, description })),
  "card:create": ({ canvasId: id, starter, x, y }) => {
    const s = starters.find((x) => x.id === starter);
    if (!s) throw new Error("There's no such starter card.");
    return cards.create({
      canvasId: id,
      title: s.title,
      html: s.html,
      files: s.files,
      ...(s.refreshScript && { refreshScript: s.refreshScript }),
      x: x - CARD_SIZE.w / 2,
      y: y - CARD_SIZE.h / 2,
    });
  },
  "card:openFolder": async ({ cardId }) => {
    if (!cards.row(cardId)) return { ok: false };
    return { ok: (await shell.openPath(cards.dir(cardId))) === "" };
  },
  "flow:templates": () => TEMPLATES.map(({ id, title, description }) => ({ id, title, description })),
  "flow:create": async ({ template, spec, x, y }) => {
    const t = template ? TEMPLATES.find((x) => x.id === template) : undefined;
    const s = spec ?? t?.spec;
    if (!s) throw new Error("Pick a template.");
    return createFlowFrom(s, x, y);
  },
  "flow:start": ({ flowId, input }) => {
    flows.start(flowId, input, "you");
    return store.flowInfo(flowId)!;
  },
  "flow:control": ({ flowId, action }) => {
    flows.control(flowId, action);
    return store.flowInfo(flowId)!;
  },
  "flow:approve": ({ flowId, approvalId, action, feedback, text }) => {
    flows.approve(flowId, approvalId, action, feedback, text);
    return store.flowInfo(flowId)!;
  },
  "flow:loop": ({ flowId, continue: go }) => {
    flows.loop(flowId, go);
    return store.flowInfo(flowId)!;
  },
  "flow:update": ({ flowId, name, brief, schedule, loopLimit }) => {
    const f = store.flowRow(flowId);
    if (!f) throw new Error("That flow no longer exists.");
    store.updateFlow(flowId, {
      ...(name !== undefined && { name }),
      ...(brief !== undefined && { brief }),
      ...(loopLimit !== undefined && { loopLimit }),
      ...(schedule !== undefined && {
        scheduleJson: schedule ? JSON.stringify(schedule) : null,
        nextRunAt: schedule ? nextRun(schedule, Date.now()) : null,
      }),
    });
    if (name) store.updateNodeData(f.nodeId, { name });
    return store.flowInfo(flowId)!;
  },
  "flow:connect": ({ flowId, source, target, mode }) => {
    const f = store.flowRow(flowId);
    const [a, b] = [store.getNode(source), store.getNode(target)];
    if (!f || !a || !b || a.parentId !== f.nodeId || b.parentId !== f.nodeId) throw new Error("Connect two things inside the same flow.");
    if (source === target) throw new Error("A node can't feed itself.");
    if (b.type === "start") throw new Error("Nothing goes into a Start node.");
    if (store.edgesOf(flowId).some((e) => e.source === source && e.target === target)) throw new Error("They're already connected.");
    const e = store.addEdge({ flowId, source, target, mode: mode ?? "every" });
    return e;
  },
  "flow:edge": ({ edgeId, mode }) => {
    if (!store.edge(edgeId)) return { ok: false };
    if (mode === null) store.removeEdge(edgeId);
    else store.setEdgeMode(edgeId, mode);
    return { ok: true };
  },
  "flow:setJob": ({ nodeId, job }) => {
    store.updateNodeData(nodeId, { job });
    return { ok: true };
  },
  "flow:setStart": ({ nodeId, input, oneTaskPerLine }) => {
    store.updateNodeData(nodeId, { input, oneTaskPerLine });
    return { ok: true };
  },
  "prefs:get": () => prefs(),
  "update:get": () => updates.state(),
  "data:info": () => ({ dataDir, logFile: logs.file }),
  "data:open": async () => ({ ok: (await shell.openPath(dataDir)) === "" }),
  "data:export": async () => {
    const options = {
      title: "Export the workspace to…",
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
    };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const target = r.filePaths[0];
    if (r.canceled || !target) return { path: null };
    eventLog.flush();
    const path = exportWorkspace(dataDir, target);
    if (!dataDir.includes("latis-e2e-")) shell.showItemInFolder(path);
    return { path };
  },
  "app:report": async () => ({
    diagnostics: diagnostics({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      osRelease: release(),
      electron: process.versions.electron ?? "",
      agents: await agents.list(),
      logTail: logs.tail(),
    }),
    issueUrl: issueUrl(app.getVersion(), `${process.platform} ${release()}`),
  }),
  "update:check": () => updates.check(),
  "prefs:set": (patch) => {
    const next = { ...prefs(), ...patch };
    store.setSetting("prefs", next);
    if (patch.appearance) applyUiScale();
    if (patch.alwaysAsk) supervisor.setAlwaysAsk(next.alwaysAsk);
    return next;
  },
  "appearance:pickWallpaper": async () => {
    const options = {
      title: "Choose a wallpaper",
      properties: ["openFile"] as "openFile"[],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    const buf = readFileSync(file);
    if (buf.length > 8 * 1024 * 1024) throw new Error("That image is over 8 MB. Pick a smaller one.");
    const ext = file.split(".").pop()!.toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${buf.toString("base64")}`;
  },
  "chat:setWorkspaceTools": ({ chatId, on }) => {
    const chat = store.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    if (chat.role === "conductor") throw new Error("The Conductor always has the workspace tools.");
    if (!agents.get(chat.agentId)?.capabilities.mcp) throw new Error("This agent can't use MCP tools.");
    if (supervisor.busy(chatId)) throw new Error("Wait for the current turn to finish, then try again.");
    store.setChatFlags(chatId, { workspaceTools: on });
    return restartForOptions(chatId);
  },
  "chat:setConnections": ({ chatId, ids }) => {
    if (!store.getChat(chatId)) throw new Error("That chat no longer exists.");
    if (supervisor.busy(chatId)) throw new Error("Wait for the current turn to finish, then try again.");
    const known = new Set(connections.list().map((c) => c.id));
    store.setChatFlags(chatId, { connections: ids.filter((id) => known.has(id)) });
    return restartForOptions(chatId);
  },
  "mcp:list": () => connections.list(),
  "mcp:save": (input) => connections.save(input),
  "mcp:remove": ({ id }) => {
    connections.remove(id);
    return { ok: true };
  },
  "mcp:importScan": () => connections.scan(),
  "mcp:import": ({ path, names }) => connections.import(path, names),
  "skills:list": ({ projectId }) => {
    const p = projectId ? store.getProject(projectId) : undefined;
    return skills.list(p && !p.folderMissing ? p.folderPath : null);
  },
  "skills:openFolder": async () => {
    mkdirSync(skills.userDir, { recursive: true });
    return { ok: (await shell.openPath(skills.userDir)) === "" };
  },
  "skills:import": async () => {
    const options = { title: "Import a skill folder (with SKILL.md)", properties: ["openDirectory"] as "openDirectory"[] };
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const folder = r.filePaths[0];
    if (r.canceled || !folder) return null;
    return skills.importFolder(folder);
  },
  "skills:read": ({ path }) => {
    // Only files Latis listed as skills.
    const all = [...skills.list(null), ...store.listProjects().flatMap((p) => (p.folderMissing ? [] : skills.list(p.folderPath)))];
    if (!all.some((s) => s.path === path)) throw new Error("That isn't a skill Latis knows.");
    return { body: skills.body(path) };
  },
  "conductor:setAgent": async ({ agentId }) => {
    const c = store.conductor();
    if (!c) throw new Error("There's no Conductor yet.");
    const a = agents.get(agentId);
    if (!a || (agents.isTerminal(agentId) && !agents.isHooked(agentId)) || !a.capabilities.mcp)
      throw new Error("The Conductor needs an agent that can use MCP tools.");
    if (supervisor.busy(c.id)) throw new Error("Wait for the Conductor to finish, then try again.");
    await supervisor.release(c.id);
    store.setChatFlags(c.id, { agentId, model: agentId === "fake" ? "demo-1" : null, reasoning: null });
    // A different agent can't resume the old one's conversation.
    store.updateChat(c.id, { nativeSessionId: null });
    const chat = store.getChat(c.id)!;
    emit(win?.webContents, "chat:updated", chat);
    return chat;
  },
  "conductor:openPrefs": async () => {
    ensureConductorDir();
    return { ok: (await shell.openPath(conductorPrefs)) === "" };
  },
  "settings:getTheme": () => store.getSetting<Theme>("theme") ?? "dark",
  "settings:setTheme": (theme) => {
    store.setSetting("theme", theme);
    applyTheme(theme);
    return theme;
  },
});

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0A0C0F",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    ...(process.platform !== "darwin" && { titleBarOverlay: { color: "#0A0C0F", symbolColor: "#A4ABB5", height: 40 } }),
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.on("did-finish-load", applyUiScale);
  const links = {
    openExternal: (url: string) => shell.openExternal(url),
    confirm: (message: string, detail: string) => confirmDialog(message, detail, "Open"),
  };
  // §13: Latis's own window never navigates or opens windows; links go out through openLink.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openLink(url, links);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url === win?.webContents.getURL()) return;
    e.preventDefault();
    void openLink(url, links);
  });
  win.on("closed", () => (win = null));
  win.webContents.on("render-process-gone", (_e, d) => console.error(`[renderer] gone: ${d.reason} (exit ${d.exitCode})`));

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

// §13: no <webview> anywhere; the dock browser is a WebContentsView Latis creates itself.
app.on("web-contents-created", (_e, contents) => contents.on("will-attach-webview", (ev) => ev.preventDefault()));

void app.whenReady().then(() => {
  lockDownPermissions(session.defaultSession, appUrlMatcher(process.env.ELECTRON_RENDERER_URL));
  protocol.handle("card", (req) => cards.serve(req.url));
  createWindow();
  // Only installed copies check on their own; a dev run is newer than any release anyway.
  if (app.isPackaged || process.env.LATIS_UPDATE_FEED)
    updates.start(() => prefs().checkUpdates, process.env.LATIS_UPDATE_FEED ? 500 : 10_000);
  void ensureConductor().catch((err: unknown) => console.error("[conductor] couldn't create the Conductor", err));
  scheduler.start();
  flows.resumeAll();
  setInterval(() => flows.tick(), 15_000);
  flows.tick();
  void probeUsage();
  setInterval(() => void probeUsage(), 15 * 60_000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  // §9.6 AC3: warn before killing terminals that are still running something.
  const busy = ptys.busy();
  if (busy.length && !process.env.LATIS_DATA_DIR?.includes("latis-e2e-")) {
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: busy.length === 1 ? "A terminal is still running something." : `${busy.length} terminals are still running something.`,
      detail: `${busy.map((t) => t.title).join(", ")}\n\nQuitting stops ${busy.length === 1 ? "it" : "them"}.`,
    });
    if (choice === 1) {
      e.preventDefault();
      return;
    }
  }
  e.preventDefault();
  quitting = true;
  void supervisor.disposeAll().finally(() => {
    ptys.disposeAll();
    mcpServer.stop();
    scheduler.stop();
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
