import { FolderOpen, Moon, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, Sun, SunMoon, X } from "lucide-react";
import { Button, Menu, MenuItem, MenuSeparator, cn } from "@latis/ui";
import type { Theme } from "@latis/shared";
import { AgentMenuItems } from "../canvas/AgentMenuItems";
import { useCanvasActions } from "../canvas/useCanvasActions";
import { useWorkspace } from "../stores/workspace";

export function TitleBar() {
  const theme = useWorkspace((s) => s.theme);
  const setTheme = useWorkspace((s) => s.setTheme);
  const loadAgents = useWorkspace((s) => s.loadAgents);
  const { openFolder, newChat } = useCanvasActions();
  const zen = useWorkspace((s) => s.zen);
  const views = useWorkspace((s) => s.views);
  const activeView = useWorkspace((s) => s.activeView);
  const { openView, closeView, focusSelection } = useWorkspace.getState();
  const isMac = window.latis.platform === "darwin";
  const themes: { id: Theme; label: string; icon: typeof Sun }[] = [
    { id: "dark", label: "Dark", icon: Moon },
    { id: "light", label: "Light", icon: Sun },
    { id: "system", label: "Match system", icon: SunMoon },
  ];

  return (
    <header
      className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-line bg-bg-0 pr-2"
      style={{ paddingLeft: isMac ? 84 : 12 }}
    >
      <span className="text-[13px] font-semibold tracking-wide text-text-1">Latis</span>
      {!zen && (
        <nav className="no-drag ml-3 flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Canvases and focus views" role="tablist">
          <button
            role="tab"
            aria-selected={!activeView}
            onClick={() => openView(null)}
            className={cn(
              "flex h-7 shrink-0 items-center rounded-control border px-3 text-[12px] font-medium",
              !activeView ? "border-line bg-surface text-text-1" : "border-transparent text-text-3 hover:text-text-1",
            )}
          >
            Main canvas
          </button>
          {views.map((v) => (
            <div
              key={v.id}
              role="tab"
              aria-selected={activeView === v.id}
              className={cn(
                "group flex h-7 shrink-0 items-center gap-1 rounded-control border pl-3 pr-1 text-[12px] font-medium",
                activeView === v.id ? "border-line bg-surface text-text-1" : "border-transparent text-text-3 hover:text-text-1",
              )}
              data-testid="view-tab"
            >
              <button onClick={() => openView(v.id)} className="max-w-40 truncate">
                Focus: {v.name}
              </button>
              <button
                aria-label={`Close ${v.name}`}
                className="rounded p-0.5 opacity-60 hover:bg-surface-2 hover:opacity-100"
                onClick={() => closeView(v.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <Button variant="ghost" size="icon" aria-label="Focus the selected chats (F)" onClick={() => focusSelection()}>
            <Plus size={14} />
          </Button>
        </nav>
      )}
      <div className="flex-1" />
      <div className="no-drag flex items-center gap-1" style={{ marginRight: isMac ? 0 : 140 }}>
        <Button variant="ghost" size="sm" onClick={() => void openFolder()} data-testid="open-folder">
          <FolderOpen size={13} /> Open folder
        </Button>
        <Menu
          trigger={
            <Button variant="secondary" size="sm" data-testid="new-chat">
              <Plus size={13} /> New chat
            </Button>
          }
        >
          <AgentMenuItems onPick={(id) => void newChat(id)} />
        </Menu>
        <button
          className="flex h-7 w-56 items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-[12px] text-text-3"
          aria-label="Search and commands"
          onClick={() => useWorkspace.setState({ paletteOpen: true })}
          data-testid="open-palette"
        >
          <Search size={13} /> Search <kbd className="ml-auto font-mono text-[11px]">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <Menu
          trigger={
            <Button variant="ghost" size="icon" aria-label="Settings">
              <Settings size={15} />
            </Button>
          }
        >
          {themes.map((t) => (
            <MenuItem key={t.id} onSelect={() => void setTheme(t.id)}>
              <t.icon size={14} /> {t.label}
              {theme === t.id && <span className="ml-auto text-accent">●</span>}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => useWorkspace.getState().setSettingsOpen(true)}>
            <SlidersHorizontal size={14} /> Settings…
          </MenuItem>
          <MenuItem onSelect={() => useWorkspace.setState({ onboardingOpen: true })}>
            <Sparkles size={14} /> Show me around
          </MenuItem>
          <MenuItem onSelect={() => void loadAgents(true)}>
            <RefreshCw size={14} /> Re-check agents
          </MenuItem>
          <MenuItem onSelect={() => void window.latis.invoke("app:info").then((i) => alert(`Latis ${i.version}\nData: ${i.dataDir}`))}>
            About Latis
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}
