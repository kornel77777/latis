import { FolderOpen, Moon, Plus, RefreshCw, Search, Settings, SlidersHorizontal, Sparkles, Sun, SunMoon } from "lucide-react";
import { Button, Menu, MenuItem, MenuSeparator } from "@latis/ui";
import type { Theme } from "@latis/shared";
import { AgentMenuItems } from "../canvas/AgentMenuItems";
import { useCanvasActions } from "../canvas/useCanvasActions";
import { useWorkspace } from "../stores/workspace";

export function TitleBar() {
  const theme = useWorkspace((s) => s.theme);
  const setTheme = useWorkspace((s) => s.setTheme);
  const loadAgents = useWorkspace((s) => s.loadAgents);
  const { openFolder, newChat } = useCanvasActions();
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
      <nav className="no-drag ml-3 flex items-center gap-1" aria-label="Canvases">
        <div className="flex h-7 items-center rounded-control border border-line bg-surface px-3 text-[12px] font-medium text-text-1">
          Main canvas
        </div>
        <Button variant="ghost" size="icon" aria-label="New canvas (coming later)" disabled>
          <Plus size={14} />
        </Button>
      </nav>
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
          aria-label="Search (coming in M4)"
          disabled
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
