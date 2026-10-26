import {
  Bug,
  FolderOpen,
  Grid2x2,
  Keyboard,
  LayoutDashboard,
  Moon,
  Plus,
  RefreshCw,
  ScanSearch,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  SunMoon,
  X,
} from "lucide-react";
import { display } from "../commands/keys";
import { allCommands, bindingsOf, runCommand } from "../commands/registry";
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
  const mode = useWorkspace((s) => s.prefs?.layoutMode ?? "lattice");
  const bindings = useWorkspace((s) => s.prefs?.keybindings);
  const shortcutOf = (id: string) => {
    const c = allCommands().find((x) => x.id === id);
    const k = c && bindingsOf(c, bindings)[0];
    return k ? display(k) : "";
  };
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
        <nav
          className="no-drag ml-3 flex min-w-0 items-center gap-1 overflow-x-auto"
          aria-label="Canvases and Lock In views"
          role="tablist"
        >
          <div className="flex shrink-0 rounded-control border border-line bg-bg-1 p-0.5" role="radiogroup" aria-label="Layout">
            {(
              [
                ["lattice", Grid2x2, "Lattice", "view.lattice"],
                ["canvas", LayoutDashboard, "Canvas", "view.canvas"],
              ] as const
            ).map(([m, Icon, label, cmd]) => {
              const on = !activeView && mode === m;
              const key = shortcutOf(cmd);
              return (
                <button
                  key={m}
                  role="radio"
                  aria-checked={on}
                  title={key ? `${label} (${key})` : label}
                  onClick={() => runCommand(cmd)}
                  data-testid={`mode-${m}`}
                  className={cn(
                    "flex h-6 items-center gap-1.5 rounded-control px-2.5 text-[12px] font-medium transition-colors duration-fast",
                    on ? "bg-surface text-text-1 shadow-sm" : "text-text-3 hover:text-text-1",
                  )}
                >
                  <Icon size={12} className={on ? "text-accent" : undefined} /> {label}
                </button>
              );
            })}
          </div>
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
                Lock In: {v.name}
              </button>
              <button
                aria-label={`Close ${v.name}`}
                className="rounded-[2px] p-0.5 opacity-60 hover:bg-surface-2 hover:opacity-100"
                onClick={() => closeView(v.id)}
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Lock In on the selected chats (F)"
            title="Lock In: open the selected chats side by side in their own tab (F)"
            onClick={() => focusSelection()}
          >
            <ScanSearch size={13} /> Lock In
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
          <Search size={13} /> Search and commands <kbd className="ml-auto font-mono text-[11px]">{shortcutOf("palette.toggle")}</kbd>
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
          <MenuItem onSelect={() => useWorkspace.getState().setSettingsOpen(true, "Commands")}>
            <Keyboard size={14} /> Commands and shortcuts…
          </MenuItem>
          <MenuItem onSelect={() => useWorkspace.setState({ onboardingOpen: true })}>
            <Sparkles size={14} /> Show me around
          </MenuItem>
          <MenuItem onSelect={() => void loadAgents(true)}>
            <RefreshCw size={14} /> Re-check agents
          </MenuItem>
          <MenuItem onSelect={() => void useWorkspace.getState().reportProblem()}>
            <Bug size={14} /> Report a problem…
          </MenuItem>
          <MenuItem onSelect={() => useWorkspace.getState().setSettingsOpen(true, "General")}>About Latis</MenuItem>
        </Menu>
      </div>
    </header>
  );
}
