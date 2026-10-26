import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";
import { surfaces, type Command } from "./registry";
import { stackAgent } from "../lattice/collab";
import { broadcastInput } from "../lattice/LatticeBars";

// The built-in commands. Titles read as actions; the defaults keep every shortcut Latis had.

const ws = () => useWorkspace.getState();
const centre = () => surfaces.canvas?.center() ?? { x: 0, y: 0 };
const selectedChat = () => {
  const s = ws();
  const n = s.nodes.find((x) => x.selected && x.data.chatId);
  return n?.data.chatId ? s.chats[n.data.chatId]?.summary : undefined;
};
const openPalette = (query = "") => useWorkspace.setState({ paletteOpen: true, paletteQuery: query });
const inLattice = () => !ws().activeView && (ws().prefs?.layoutMode ?? "lattice") === "lattice";
/** A new chat with the focused pane's agent and project, tiled beside it. */
const splitFocused = (zone: "right" | "down") => {
  const s = ws();
  const c = s.latticeFocus ? s.chats[s.latticeFocus]?.summary : undefined;
  if (c) void stackAgent(c.agentId, c.projectId, { target: c.id, zone });
};
const setMode = (layoutMode: "canvas" | "lattice") => {
  useWorkspace.setState({ activeView: null });
  void ws().setPrefs({ layoutMode });
};

export function builtInCommands(): Command[] {
  return [
    // ── General ──────────────────────────────────────────────────────────────
    {
      id: "palette.toggle",
      title: "Command palette",
      category: "General",
      keys: ["Mod+K"],
      palette: false,
      run: () => useWorkspace.setState((s) => ({ paletteOpen: !s.paletteOpen, paletteQuery: "" })),
    },
    { id: "settings.open", title: "Open settings", category: "General", keys: ["Mod+,"], run: () => ws().setSettingsOpen(true) },
    {
      id: "commands.open",
      title: "Commands and shortcuts",
      category: "General",
      keys: ["Mod+/"],
      run: () => ws().setSettingsOpen(true, "Commands"),
    },
    { id: "sidebar.toggle", title: "Toggle sidebar", category: "General", keys: ["Mod+B"], run: () => ws().toggleSidebar() },
    { id: "dock.toggle", title: "Toggle terminal dock", category: "General", keys: ["Mod+`"], run: () => ws().toggleDock() },
    {
      id: "dock.browser",
      title: "Open the dock browser",
      category: "General",
      keys: ["Mod+Shift+B"],
      run: () => useWorkspace.setState({ dockOpen: true, dockTab: "Browser" }),
    },
    {
      id: "zen.toggle",
      title: "Distraction-free mode",
      category: "General",
      keys: ["Mod+Shift+F"],
      run: () => useWorkspace.setState((s) => ({ zen: !s.zen })),
    },
    {
      id: "theme.toggle",
      title: "Switch light / dark theme",
      category: "General",
      run: () => void ws().setTheme(ws().theme === "light" ? "dark" : "light"),
    },
    { id: "agents.recheck", title: "Re-check agents", category: "General", run: () => void ws().loadAgents(true) },
    { id: "tour.show", title: "Show me around", category: "General", run: () => useWorkspace.setState({ onboardingOpen: true }) },
    {
      id: "perf.toggle",
      title: "Performance overlay",
      category: "General",
      keys: ["Ctrl+Alt+P"],
      palette: false,
      run: () => window.dispatchEvent(new Event("latis-perf-toggle")),
    },

    // ── Navigate ─────────────────────────────────────────────────────────────
    { id: "view.lattice", title: "Show the lattice", category: "Navigate", keys: ["Mod+1"], run: () => setMode("lattice") },
    { id: "view.canvas", title: "Show the canvas", category: "Navigate", keys: ["Mod+2"], run: () => setMode("canvas") },
    {
      id: "view.toggle",
      title: "Switch canvas / lattice",
      category: "Navigate",
      keys: ["Mod+Shift+L"],
      run: () => setMode((ws().prefs?.layoutMode ?? "lattice") === "canvas" ? "lattice" : "canvas"),
    },
    { id: "inbox.next", title: "Next item that needs you", category: "Navigate", keys: ["Ctrl+J"], run: () => ws().jumpAttention(1) },
    {
      id: "inbox.prev",
      title: "Previous item that needs you",
      category: "Navigate",
      keys: ["Ctrl+Shift+J"],
      run: () => ws().jumpAttention(-1),
    },
    { id: "inbox.show", title: "Show the Inbox", category: "Navigate", run: () => ws().setSidebarTab("inbox") },
    {
      id: "review.toggle",
      title: "Review changes",
      category: "Navigate",
      keys: ["Mod+Shift+R"],
      run: () => (ws().reviewPanel.open ? ws().closeReview() : ws().openReview()),
    },
    {
      id: "conductor.ask",
      title: "Ask the Conductor",
      category: "Navigate",
      keys: ["Mod+Shift+K"],
      when: () => Object.values(ws().chats).some((c) => c.summary.role === "conductor"),
      run: () => {
        const c = Object.values(ws().chats).find((x) => x.summary.role === "conductor")!.summary;
        ws().focusChat(c.id);
        useWorkspace.setState({ focusComposer: c.id });
      },
    },

    // ── Create ───────────────────────────────────────────────────────────────
    { id: "chat.new", title: "New chat…", category: "Create", keys: ["Mod+N"], run: () => openPalette("New chat with") },
    { id: "folder.open", title: "Open folder as project…", category: "Create", keys: ["Mod+O"], run: () => void ws().openFolder(centre()) },
    {
      id: "note.new",
      title: "New note",
      category: "Create",
      keys: ["N"],
      scope: "canvas",
      run: () => void ws().createNote({ x: centre().x - 170, y: centre().y - 130 }),
    },
    {
      id: "label.new",
      title: "New section label",
      category: "Create",
      keys: ["L"],
      scope: "canvas",
      run: () => void ws().createLabel(centre()),
    },
    { id: "card.new", title: "New card…", category: "Create", run: () => useWorkspace.setState({ cardLibraryAt: centre() }) },
    { id: "flow.new", title: "New flow…", category: "Create", run: () => useWorkspace.setState({ flowTemplatesAt: centre() }) },
    {
      id: "terminal.new",
      title: "New terminal",
      category: "Create",
      keys: ["Ctrl+Shift+`"],
      run: () =>
        void ws().newTerminal(
          selectedChat()?.projectId ?? (Object.keys(ws().projects).length === 1 ? Object.keys(ws().projects)[0]! : null),
        ),
    },

    // ── Chat (the selected one) ──────────────────────────────────────────────
    {
      id: "chat.compose",
      title: "Write to the selected chat",
      category: "Chat",
      keys: ["Enter"],
      scope: "canvas",
      palette: false,
      when: () => Boolean(selectedChat()),
      run: () => useWorkspace.setState({ focusComposer: selectedChat()!.id }),
    },
    {
      id: "chat.stop",
      title: "Stop the selected chat",
      category: "Chat",
      keys: ["Mod+."],
      when: () => ["working", "needs-you"].includes(selectedChat()?.status ?? ""),
      run: () => void ws().interrupt(selectedChat()!.id),
    },
    {
      id: "chat.timeline",
      title: "Timeline of the selected chat",
      category: "Chat",
      when: () => Boolean(selectedChat()),
      run: () => useWorkspace.setState({ timelineFor: selectedChat()!.id }),
    },
    {
      id: "chat.handoff",
      title: "Continue the selected chat with another agent…",
      category: "Chat",
      when: () => Boolean(selectedChat()),
      run: () => useWorkspace.setState({ handoffFor: selectedChat()!.id }),
    },
    {
      id: "chat.tools",
      title: "Give / remove workspace tools (selected chat)",
      category: "Chat",
      when: () => Boolean(selectedChat() && !selectedChat()!.role),
      run: () => void ws().setWorkspaceTools(selectedChat()!.id, !selectedChat()!.workspaceTools),
    },
    {
      id: "chat.isolate",
      title: "Move the selected chat into its own copy",
      category: "Chat",
      when: () => Boolean(selectedChat()?.projectId && !selectedChat()?.worktree),
      run: () =>
        void latis
          .invoke("chat:isolate", { chatId: selectedChat()!.id })
          .catch((err: unknown) => ws().toast(err instanceof Error ? err.message : String(err))),
    },

    // ── Canvas ───────────────────────────────────────────────────────────────
    { id: "canvas.undo", title: "Undo (canvas)", category: "Canvas", keys: ["Mod+Z"], scope: "canvas", run: () => void ws().undo() },
    { id: "canvas.redo", title: "Redo (canvas)", category: "Canvas", keys: ["Mod+Shift+Z"], scope: "canvas", run: () => void ws().redo() },
    {
      id: "canvas.selectAll",
      title: "Select everything",
      category: "Canvas",
      keys: ["Mod+A"],
      scope: "canvas",
      run: () =>
        useWorkspace.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, selected: n.type !== "frame" && n.type !== "flow" })) })),
    },
    {
      id: "canvas.delete",
      title: "Delete selection",
      category: "Canvas",
      keys: ["Delete", "Backspace"],
      scope: "canvas",
      when: () => ws().nodes.some((n) => n.selected),
      run: () =>
        void ws().deleteNodes(
          ws()
            .nodes.filter((n) => n.selected)
            .map((n) => n.id),
        ),
    },
    {
      id: "canvas.focus",
      title: "Lock In on the selected chats",
      category: "Canvas",
      keys: ["F"],
      scope: "canvas",
      run: () => ws().focusSelection(),
    },
    {
      id: "canvas.fitAll",
      title: "Fit everything",
      category: "Canvas",
      keys: ["Shift+1"],
      scope: "canvas",
      run: () => surfaces.canvas?.fitAll(),
    },
    {
      id: "canvas.fitSelection",
      title: "Fit the selection",
      category: "Canvas",
      keys: ["Shift+2"],
      scope: "canvas",
      run: () => surfaces.canvas?.fitSelection(),
    },
    {
      id: "canvas.zoomReset",
      title: "Zoom to 100%",
      category: "Canvas",
      keys: ["0"],
      scope: "canvas",
      run: () => surfaces.canvas?.zoomReset(),
    },
    { id: "canvas.zoomIn", title: "Zoom in", category: "Canvas", keys: ["="], scope: "canvas", run: () => surfaces.canvas?.zoomIn() },
    { id: "canvas.zoomOut", title: "Zoom out", category: "Canvas", keys: ["-"], scope: "canvas", run: () => surfaces.canvas?.zoomOut() },
    { id: "canvas.tidy", title: "Tidy up frames", category: "Canvas", keys: ["Shift+T"], scope: "canvas", run: () => ws().tidyUp() },

    // ── Lattice ──────────────────────────────────────────────────────────────
    ...(["left", "right", "up", "down"] as const).flatMap((d): Command[] => {
      const key = { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown" }[d];
      return [
        {
          id: `lattice.focus.${d}`,
          title: `Focus the pane ${d === "up" ? "above" : d === "down" ? "below" : `to the ${d}`}`,
          category: "Lattice",
          keys: [`Mod+Alt+${key}`],
          scope: "lattice",
          run: () => surfaces.lattice?.focus(d),
        },
        {
          id: `lattice.move.${d}`,
          title: `Move the pane ${d}`,
          category: "Lattice",
          keys: [`Mod+Alt+Shift+${key}`],
          scope: "lattice",
          run: () => surfaces.lattice?.move(d),
        },
      ];
    }),
    {
      id: "lattice.maximize",
      title: "Maximise / restore the focused pane",
      category: "Lattice",
      keys: ["Mod+Shift+Enter"],
      scope: "lattice",
      run: () => surfaces.lattice?.toggleMaximize(),
    },
    {
      id: "lattice.close",
      title: "Take the focused chat out of the lattice",
      category: "Lattice",
      keys: ["Mod+Shift+W"],
      scope: "lattice",
      run: () => surfaces.lattice?.closePane(),
    },
    {
      id: "lattice.grid",
      title: "Arrange as a grid",
      category: "Lattice",
      keys: ["Mod+Alt+G"],
      scope: "lattice",
      run: () => surfaces.lattice?.arrange("grid"),
    },
    {
      id: "lattice.columns",
      title: "Arrange in columns",
      category: "Lattice",
      keys: ["Mod+Alt+C"],
      scope: "lattice",
      run: () => surfaces.lattice?.arrange("columns"),
    },
    {
      id: "lattice.rows",
      title: "Arrange in rows",
      category: "Lattice",
      keys: ["Mod+Alt+R"],
      scope: "lattice",
      run: () => surfaces.lattice?.arrange("rows"),
    },
    {
      id: "lattice.main",
      title: "Arrange as main + stack",
      category: "Lattice",
      keys: ["Mod+Alt+M"],
      scope: "lattice",
      run: () => surfaces.lattice?.arrange("main"),
    },
    {
      id: "lattice.splitRight",
      title: "Split right with the same agent",
      category: "Lattice",
      keys: ["Mod+\\"],
      when: inLattice,
      run: () => splitFocused("right"),
    },
    {
      id: "lattice.splitDown",
      title: "Split down with the same agent",
      category: "Lattice",
      keys: ["Mod+Shift+\\"],
      when: inLattice,
      run: () => splitFocused("down"),
    },
    {
      id: "lattice.broadcast",
      title: "Message every chat in the lattice",
      category: "Lattice",
      keys: ["Mod+Shift+A"],
      when: inLattice,
      run: () => broadcastInput.current?.focus(),
    },
    {
      id: "lattice.equalize",
      title: "Make panes equal size",
      category: "Lattice",
      keys: ["Mod+Alt+="],
      scope: "lattice",
      run: () => surfaces.lattice?.equalize(),
    },
  ];
}
