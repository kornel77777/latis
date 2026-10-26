import { useRef, useState } from "react";
import { Plus, Search, SquareTerminal, X } from "lucide-react";
import { cn } from "@latis/ui";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../stores/workspace";
import { TerminalView, type TerminalHandle } from "../terminal/TerminalView";
import { BrowserPanel } from "./BrowserPanel";

const tabs = ["Terminal", "Browser", "Files", "Diff"] as const;

export function Dock() {
  const tab = useWorkspace((s) => s.dockTab);
  const setTab = (t: (typeof tabs)[number]) => useWorkspace.setState({ dockTab: t });
  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-line bg-bg-0" aria-label="Dock">
      <div role="tablist" className="flex gap-0.5 border-b border-line p-1.5">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "h-7 flex-1 rounded-control text-[12px] font-medium transition-colors duration-fast",
              tab === t ? "bg-surface-2 text-text-1" : "text-text-3 hover:text-text-2",
            )}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Terminal" ? (
        <Terminals />
      ) : tab === "Browser" ? (
        <BrowserPanel />
      ) : (
        <div className="p-4 text-[12px] text-text-3">
          {tab === "Diff" ? "Diffs open in the Review panel (Ctrl/⌘+Shift+R)." : "The file viewer comes later."}
        </div>
      )}
    </aside>
  );
}

/** The project a new terminal opens in: the selected node's project, else the only project. */
function useTargetProject(): string | null {
  return useWorkspace((s) => {
    const sel = s.nodes.find((n) => n.selected);
    const fromSel = sel
      ? (s.projects[sel.data.projectId ?? ""]?.id ?? Object.values(s.projects).find((p) => p.frameNodeId === sel.id)?.id)
      : undefined;
    const all = Object.keys(s.projects);
    return fromSel ?? (all.length === 1 ? all[0]! : null);
  });
}

function Terminals() {
  const ptys = useWorkspace(useShallow((s) => s.ptys));
  const active = useWorkspace((s) => s.activePty);
  const { newTerminal, closePty } = useWorkspace(useShallow((s) => ({ newTerminal: s.newTerminal, closePty: s.closePty })));
  const target = useTargetProject();
  const handles = useRef(new Map<string, TerminalHandle>());
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-1.5 py-1" role="tablist" aria-label="Terminals">
        <div className="flex min-w-0 flex-1 gap-0.5 overflow-x-auto">
          {ptys.map((p) => (
            <div
              key={p.id}
              role="tab"
              aria-selected={p.id === active}
              className={cn(
                "group flex h-7 shrink-0 items-center gap-1.5 rounded-control pl-2 pr-1 text-[12px]",
                p.id === active ? "bg-surface-2 text-text-1" : "text-text-3 hover:text-text-2",
              )}
            >
              <button
                className="flex items-center gap-1.5"
                onClick={() => useWorkspace.setState({ activePty: p.id })}
                data-testid="terminal-tab"
              >
                <SquareTerminal size={12} className={p.running ? "text-accent" : "text-text-3"} />
                <span className="max-w-40 truncate">{p.title}</span>
                {!p.running && <span className="text-text-3">(exited)</span>}
              </button>
              <button
                aria-label={`Close ${p.title}`}
                className="rounded-[2px] p-0.5 opacity-60 hover:bg-surface hover:opacity-100"
                onClick={() => void closePty(p.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
        <button
          aria-label="Search terminal"
          className="rounded-control p-1.5 text-text-3 hover:bg-surface-2 hover:text-text-1"
          onClick={() => setSearching((v) => !v)}
        >
          <Search size={13} />
        </button>
        <button
          aria-label="New terminal"
          data-testid="new-terminal"
          className="rounded-control p-1.5 text-text-3 hover:bg-surface-2 hover:text-text-1"
          onClick={() => void newTerminal(target)}
        >
          <Plus size={14} />
        </button>
      </div>
      {searching && active && (
        <input
          autoFocus
          value={query}
          placeholder="Find in terminal (Enter / Shift+Enter)"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query) handles.current.get(active)?.search(query, e.shiftKey);
            if (e.key === "Escape") setSearching(false);
          }}
          className="mx-1.5 mt-1.5 h-7 rounded-control border border-line bg-surface px-2 text-[12px] text-text-1 outline-none focus:border-accent"
        />
      )}
      <div className="relative min-h-0 flex-1">
        {ptys.map((p) => (
          <div key={p.id} className={cn("absolute inset-0 p-1.5", p.id !== active && "invisible")}>
            <TerminalView ptyId={p.id} active={p.id === active} onReady={(h) => handles.current.set(p.id, h)} className="h-full w-full" />
          </div>
        ))}
        {ptys.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-[12px] text-text-3">
            <SquareTerminal size={22} />
            <p>One terminal per project, in the project's folder, with your shell and login environment.</p>
            <button
              className="h-7 rounded-control bg-accent px-3 text-[12px] font-medium text-accent-fg hover:opacity-90"
              onClick={() => void newTerminal(target)}
            >
              Open a terminal
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
