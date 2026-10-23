import { app, BrowserWindow, dialog, nativeTheme, shell } from "electron";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AttentionItem, PermissionMode, Prefs, RequestResponse, Theme } from "@latis/shared";
import { AgentRegistry } from "./agents/registry";
import { shellEnv } from "./agents/shell-env";
import { SessionSupervisor } from "./agents/supervisor";
import { Changes } from "./git/changes";
import { EventCoalescer } from "./ipc/coalescer";
import { emit, registerHandlers } from "./ipc/register";
import { Notifier } from "./notify";
import { resolveDataDir } from "./paths";
import { openDb } from "./store/db";
import { EventLog } from "./store/event-log";
import { WorkspaceStore } from "./store/workspace";
import { PtyManager } from "./terminal/pty-manager";

const here = fileURLToPath(new URL(".", import.meta.url));
let win: BrowserWindow | null = null;

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
app.setPath("userData", join(dataDir, "electron"));

if (!app.requestSingleInstanceLock() && !process.env.LATIS_DATA_DIR) app.quit();

const store = new WorkspaceStore(openDb(join(dataDir, "latis.db")));
const eventLog = new EventLog(store);
const canvasId = store.ensureDefaultCanvas();

// Chats can't still be running after a restart; anything mid-flight goes back to idle.
for (const chat of store.loadCanvas(canvasId).chats) {
  if (chat.status === "working" || chat.status === "needs-you") store.updateChat(chat.id, { status: "idle" });
}

const ptys = new PtyManager(() => import("node-pty"), {
  data: (id, data) => emit(win?.webContents, "pty:data", { id, data }),
  exit: (id, code) => emit(win?.webContents, "pty:exit", { id, code }),
});

// LATIS_REPLAY=<fixtures dir> swaps live agent CLIs for recorded streams (e2e tests; no network, no tokens).
// LATIS_CLAUDE_REPLAY=<fixtures/claude-code> is the M1 spelling and still works.
const replayRoot =
  process.env.LATIS_REPLAY ?? (process.env.LATIS_CLAUDE_REPLAY ? resolve(process.env.LATIS_CLAUDE_REPLAY, "..") : undefined);
const agents = new AgentRegistry({
  dataDir,
  ptys,
  fakeRunnerPath: join(here, "fake-runner.js"),
  ...(replayRoot && { replayRoot }),
});

// LATIS_SKIP_ONBOARDING=1 (e2e) starts as if the first-run tour was done.
const DEFAULT_PREFS: Prefs = { onboarded: process.env.LATIS_SKIP_ONBOARDING === "1", notifyNeedsYou: true, notifyFinished: true };
function prefs(): Prefs {
  return { ...DEFAULT_PREFS, ...store.getSetting<Partial<Prefs>>("prefs") };
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

const changes = new Changes(store, dataDir, {
  reviews: (items) => emit(win?.webContents, "reviews:changed", items),
  timeline: (chatId, entries) => emit(win?.webContents, "chat:timeline", { chatId, entries }),
  note: (chatId, text) => supervisor.addNote(chatId, text),
  message: async (chatId, text) => {
    await supervisor.steer(chatId, text);
  },
});

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
  },
  {
    beforeTurn: (chatId, turnId) => changes.beforeTurn(chatId, turnId),
    afterTurn: (chatId, turnId, finalMessage) => changes.afterTurn(chatId, turnId, finalMessage),
  },
);
notifier.badge(store.openAttention());

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
}) {
  const info = await ptys.create({ ...spec, env: await shellEnv(), place: "dock" });
  emit(win?.webContents, "pty:opened", info);
  return info;
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
  "app:info": () => ({ version: app.getVersion(), platform: process.platform, dataDir }),
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
    const info = await dockTerminal({ ...pty, cwd: homedir(), title: `Sign in · ${a.displayName}`, projectId: null, chatId: null });
    // Re-check once the sign-in terminal closes, so the agent shows as signed in.
    const unsub = ptys.subscribe(info.id, (e) => {
      if (e.exit === undefined) return;
      unsub();
      void agents.list(true).then((list) => emit(win?.webContents, "agents:changed", list));
    });
    return info;
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
      permissionMode: permissionMode ?? store.getSetting<PermissionMode>("defaultPermissionMode") ?? "auto-edit",
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
  "chat:send": ({ chatId, text }) => supervisor.send(chatId, text),
  "chat:steer": ({ chatId, text }) => supervisor.steer(chatId, text),
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
  "prefs:get": () => prefs(),
  "prefs:set": (patch) => {
    const next = { ...prefs(), ...patch };
    store.setSetting("prefs", next);
    return next;
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  win.on("closed", () => (win = null));

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(here, "../renderer/index.html"));
}

void app.whenReady().then(() => {
  createWindow();
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
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
