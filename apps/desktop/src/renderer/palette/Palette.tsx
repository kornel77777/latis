import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useReactFlow } from "@xyflow/react";
import {
  ArchiveRestore,
  Bot,
  File,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitMerge,
  History,
  LayoutGrid,
  MessageSquare,
  Moon,
  Network,
  PanelLeft,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  SquareTerminal,
  StickyNote,
  Sun,
  TextSearch,
} from "lucide-react";
import { cn } from "@latis/ui";
import { latis } from "../api";
import { useCanvasActions } from "../canvas/useCanvasActions";
import { useWorkspace } from "../stores/workspace";
import { fuzzyPositions, fuzzyScore } from "./fuzzy";

// Command palette (§8.8, §9.16): actions, projects, chats (by title and content), notes,
// files in the active project, settings, and deleted items to restore.

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  /** Already matched (search results); skip fuzzy filtering. */
  matched?: boolean;
  run: () => void;
}

type SearchHit = Awaited<ReturnType<typeof latis.invoke<"search:query">>>[number];
type Deleted = Awaited<ReturnType<typeof latis.invoke<"canvas:deleted">>>[number];

const GROUP_ORDER = ["Actions", "Chats", "Projects", "Notes", "In chats and notes", "Files", "Settings", "Restore"];
const MAX_PER_GROUP = 8;

function Highlighted({ text, query }: { text: string; query: string }) {
  const at = new Set(fuzzyPositions(query, text));
  if (!at.size) return <>{text}</>;
  return (
    <>
      {[...text].map((ch, i) =>
        at.has(i) ? (
          <span key={i} className="text-accent">
            {ch}
          </span>
        ) : (
          ch
        ),
      )}
    </>
  );
}

/** FTS snippets mark matches with [ and ]. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="rounded-[3px] bg-accent/20 px-0.5 text-text-1">
            {p.slice(1, -1)}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

export function Palette() {
  const open = useWorkspace((s) => s.paletteOpen);
  const close = () => useWorkspace.setState({ paletteOpen: false });
  return (
    <RadixDialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <RadixDialog.Content
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[min(92vw,640px)] -translate-x-1/2 flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-lift outline-none"
          aria-describedby={undefined}
          data-testid="palette"
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          {open && <PaletteBody close={close} />}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [deleted, setDeleted] = useState<Deleted[]>([]);
  const [files, setFiles] = useState<{ projectId: string; paths: string[] } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const ws = useWorkspace();
  const { openFolder, newChat } = useCanvasActions();
  const flow = useReactFlow();
  useEffect(() => useWorkspace.getState().markStep("palette"), []);

  // The active project: the selected node's, else the only one.
  const activeProject = useMemo(() => {
    const sel = ws.nodes.find((n) => n.selected);
    const fromSel = sel?.data.projectId ?? (sel?.data.chatId ? ws.chats[sel.data.chatId]?.summary.projectId : undefined);
    const all = Object.keys(ws.projects);
    return fromSel ?? (all.length === 1 ? all[0] : undefined);
  }, [ws.nodes, ws.chats, ws.projects]);

  useEffect(() => {
    void latis
      .invoke("canvas:deleted")
      .then(setDeleted)
      .catch(() => undefined);
    if (activeProject)
      void latis.invoke("project:files", { projectId: activeProject }).then((paths) => setFiles({ projectId: activeProject, paths }));
  }, [activeProject]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      void latis.invoke("search:query", { q }).then((r) => live && setHits(r));
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const run = (fn: () => void) => () => {
      close();
      fn();
    };
    const out: Item[] = [];
    const action = (id: string, label: string, icon: ReactNode, fn: () => void, hint?: string) =>
      out.push({ id: `a:${id}`, group: "Actions", label, icon, run: run(fn), ...(hint && { hint }) });

    // The selected chat's own actions come first (keyboard-only use, §8.12).
    const sel = ws.nodes.find((n) => n.selected && n.data.chatId);
    const chat = sel?.data.chatId ? ws.chats[sel.data.chatId]?.summary : undefined;
    if (chat) {
      const wt = chat.worktree && !chat.worktree.removed ? chat.worktree : null;
      if (chat.projectId && !wt)
        action(
          "isolate",
          `Work in its own copy: ${chat.title}`,
          <GitBranch size={14} />,
          () =>
            void latis
              .invoke("chat:isolate", { chatId: chat.id })
              .catch((err: unknown) => ws.toast(err instanceof Error ? err.message : String(err))),
        );
      if (wt) {
        action("merge", `Merge ${wt.branch} into ${wt.baseRef}…`, <GitMerge size={14} />, () =>
          useWorkspace.setState({ mergeFor: chat.id }),
        );
        action("branch", `Review changes on ${wt.branch}`, <GitCompare size={14} />, () => ws.openReview({ branchOf: chat.id }));
      }
      action("timeline", `Timeline: ${chat.title}`, <History size={14} />, () => useWorkspace.setState({ timelineFor: chat.id }));
      if (chat.status === "working" || chat.status === "needs-you")
        action("stop", `Stop: ${chat.title}`, <Square size={14} />, () => void ws.interrupt(chat.id));
      action("compose", `Write to ${chat.title}`, <MessageSquare size={14} />, () => useWorkspace.setState({ focusComposer: chat.id }));
      if (!chat.role && chat.agentId !== "fake" && ws.agents.find((a) => a.id === chat.agentId)?.kind === "structured")
        action(
          "tools",
          `${chat.workspaceTools ? "Remove" : "Give"} workspace tools: ${chat.title}`,
          <Network size={14} />,
          () => void ws.setWorkspaceTools(chat.id, !chat.workspaceTools),
        );
    }
    const conductor = Object.values(ws.chats).find((c) => c.summary.role === "conductor")?.summary;
    if (conductor)
      action("conductor", "Ask the Conductor", <Network size={14} />, () => {
        ws.focusChat(conductor.id);
        useWorkspace.setState({ focusComposer: conductor.id });
      });
    for (const a of ws.agents.filter((x) => x.installed && (x.id !== "fake" || ws.demoInProjects))) {
      action(`chat-${a.id}`, `New chat with ${a.displayName}`, <Bot size={14} />, () => void newChat(a.id));
    }
    if (!ws.demoInProjects) action("demo", "New demo chat", <Sparkles size={14} />, () => void newChat("fake"));
    action(
      "note",
      "New note",
      <StickyNote size={14} />,
      () => void ws.createNote(flow.screenToFlowPosition({ x: window.innerWidth / 2 - 170, y: window.innerHeight / 2 - 130 })),
      "N",
    );
    action("folder", "Open folder as project…", <FolderOpen size={14} />, () => void openFolder());
    action("terminal", "New terminal", <SquareTerminal size={14} />, () => void ws.newTerminal(activeProject ?? null), "Ctrl `");
    action("review", "Review changes", <GitCompare size={14} />, () => ws.openReview(), "Ctrl ⇧ R");
    action("inbox", "Show the Inbox", <MessageSquare size={14} />, () => ws.setSidebarTab("inbox"), "Ctrl J");
    action(
      "theme",
      ws.theme === "light" ? "Switch to dark theme" : "Switch to light theme",
      ws.theme === "light" ? <Moon size={14} /> : <Sun size={14} />,
      () => void ws.setTheme(ws.theme === "light" ? "dark" : "light"),
    );
    action("tidy", "Tidy canvas", <LayoutGrid size={14} />, () => ws.tidyUp());
    action("sidebar", "Toggle sidebar", <PanelLeft size={14} />, () => ws.toggleSidebar(), "Ctrl B");
    action("tour", "Show me around", <Sparkles size={14} />, () => useWorkspace.setState({ onboardingOpen: true }));
    action("agents", "Re-check agents", <RefreshCw size={14} />, () => void ws.loadAgents(true));

    for (const p of Object.values(ws.projects)) {
      out.push({
        id: `p:${p.id}`,
        group: "Projects",
        label: p.name,
        hint: p.folderPath,
        icon: <FolderOpen size={14} />,
        run: run(() => ws.focusNode(p.frameNodeId)),
      });
    }
    for (const c of Object.values(ws.chats)) {
      const agent = ws.agents.find((a) => a.id === c.summary.agentId)?.displayName ?? c.summary.agentId;
      out.push({
        id: `c:${c.summary.id}`,
        group: "Chats",
        label: c.summary.title,
        hint: agent,
        icon: <MessageSquare size={14} />,
        run: run(() => ws.focusChat(c.summary.id)),
      });
    }
    for (const n of ws.nodes.filter((x) => x.type === "note")) {
      const text = String((n.data as { text?: string }).text ?? "");
      const title =
        text
          .split("\n")
          .find((l) => l.trim())
          ?.replace(/^#+\s*/, "") || "Untitled note";
      const pick = () => {
        useWorkspace.setState((st) => ({ nodes: st.nodes.map((x) => ({ ...x, selected: x.id === n.id })) }));
        ws.focusNode(n.id);
      };
      out.push({ id: `n:${n.id}`, group: "Notes", label: title, icon: <StickyNote size={14} />, run: run(pick) });
    }
    if (files && activeProject) {
      for (const f of files.paths) {
        out.push({
          id: `f:${f}`,
          group: "Files",
          label: f,
          icon: <File size={14} />,
          run: run(() => void latis.invoke("project:openFile", { projectId: files.projectId, path: f })),
        });
      }
    }
    for (const s of ["Agents", "Conductor", "Connections", "Skills", "Appearance", "Notifications"] as const) {
      out.push({
        id: `s:${s}`,
        group: "Settings",
        label: `Settings: ${s}`,
        icon: <Settings size={14} />,
        run: run(() => ws.setSettingsOpen(true, s)),
      });
    }
    for (const d of deleted) {
      const kind = d.type === "frame" ? "project" : d.type;
      out.push({
        id: `r:${d.nodeIds[0]}`,
        group: "Restore",
        label: `Restore ${kind} “${d.title}”`,
        hint: new Date(d.deletedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
        icon: <ArchiveRestore size={14} />,
        run: run(() => void ws.restoreNodes(d.nodeIds)),
      });
    }
    return out;
  }, [ws, files, deleted, activeProject, close, newChat, openFolder, flow]);

  const shown = useMemo(() => {
    const q = query.trim();
    const scored = items
      .map((it) => ({ it, score: q ? fuzzyScore(q, `${it.label} ${it.hint ?? ""}`) : 0 }))
      .filter((x): x is { it: Item; score: number } => x.score !== null && (q !== "" || x.it.group !== "Files"))
      .sort((a, b) => b.score - a.score);
    const groups = new Map<string, Item[]>();
    for (const { it } of scored) {
      const g = groups.get(it.group) ?? [];
      if (g.length < MAX_PER_GROUP) g.push(it);
      groups.set(it.group, g);
    }
    // Content matches from the full-text index, for chats and notes whose titles didn't match.
    if (q.length >= 2) {
      const seen = new Set<string>();
      const contentHits: Item[] = [];
      for (const h of hits) {
        const key = h.chatId ?? h.nodeId ?? "";
        if (seen.has(key)) continue;
        seen.add(key);
        const chat = h.chatId ? ws.chats[h.chatId] : undefined;
        const title = chat?.summary.title ?? (h.kind === "note" ? "Note" : "Chat");
        contentHits.push({
          id: `h:${key}`,
          group: "In chats and notes",
          label: title,
          hint: h.snippet,
          icon: <TextSearch size={14} />,
          matched: true,
          run: () => {
            close();
            if (h.chatId) ws.focusChat(h.chatId);
            else if (h.nodeId) ws.focusNode(h.nodeId);
          },
        });
      }
      if (contentHits.length) groups.set("In chats and notes", contentHits.slice(0, MAX_PER_GROUP));
    }
    // Actions first when the box is empty; otherwise by best match within the fixed group order.
    return GROUP_ORDER.flatMap((g) => (groups.get(g) ?? []).map((it) => it));
  }, [items, hits, query, ws, close]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Search size={15} className="text-text-3" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              shown[active]?.run();
            }
          }}
          placeholder="Search actions, chats, notes, files…"
          aria-label="Search"
          role="combobox"
          aria-expanded
          aria-controls="palette-list"
          aria-activedescendant={shown[active] ? `pal-${active}` : undefined}
          className="h-12 flex-1 bg-transparent text-[14px] text-text-1 outline-none placeholder:text-text-3 focus-visible:outline-none"
          data-testid="palette-input"
        />
        <kbd className="font-mono text-[11px] text-text-3">esc</kbd>
      </div>
      <div ref={list} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <p className="p-6 text-center text-[13px] text-text-3">Nothing matches “{query}”.</p>}
        {shown.map((it, i) => {
          const header = i === 0 || shown[i - 1]!.group !== it.group ? it.group : null;
          return (
            <div key={it.id}>
              {header && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-3">{header}</div>}
              <div
                id={`pal-${i}`}
                data-index={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => setActive(i)}
                onClick={() => it.run()}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 text-[13px]",
                  i === active ? "bg-surface-2 text-text-1" : "text-text-2",
                )}
                data-testid="palette-item"
                data-group={it.group}
              >
                <span className="shrink-0 text-text-3">{it.icon}</span>
                <span className="shrink-0 truncate">{it.matched ? it.label : <Highlighted text={it.label} query={query} />}</span>
                {it.hint && (
                  <span className="ml-auto min-w-0 truncate pl-3 text-[12px] text-text-3">
                    {it.matched ? <Snippet text={it.hint} /> : it.hint}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
