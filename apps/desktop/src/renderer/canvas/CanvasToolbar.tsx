import { useReactFlow, useViewport } from "@xyflow/react";
import { AppWindow, LayoutGrid, Maximize, Minus, Plus, Redo2, StickyNote, Type, Undo2, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@latis/ui";
import { display } from "../commands/keys";
import { allCommands, bindingsOf, runCommand } from "../commands/registry";
import { useWorkspace } from "../stores/workspace";

// The floating canvas toolbar. Every button is a command, so its tooltip shows the
// shortcut as currently bound (Settings → Commands).

function Tool({ cmd, label, children, testId }: { cmd: string; label: string; children: ReactNode; testId?: string }) {
  const bindings = useWorkspace((s) => s.prefs?.keybindings);
  const c = allCommands().find((x) => x.id === cmd);
  const key = c && bindingsOf(c, bindings)[0];
  return (
    <button
      aria-label={label}
      title={key ? `${label} (${display(key)})` : label}
      onClick={() => runCommand(cmd)}
      className="flex h-7 min-w-7 items-center justify-center rounded-[7px] px-1.5 text-text-2 transition-colors duration-fast hover:bg-surface-2 hover:text-text-1"
      {...(testId && { "data-testid": testId })}
    >
      {children}
    </button>
  );
}

const Sep = () => <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />;

export function CanvasToolbar() {
  const { zoom } = useViewport();
  const flow = useReactFlow();
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className={cn(
        "absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-[11px] border border-line bg-surface/90 p-1 shadow-lift backdrop-blur",
      )}
      data-testid="canvas-toolbar"
    >
      <Tool cmd="canvas.fitAll" label="Fit everything">
        <Maximize size={14} />
      </Tool>
      <Tool cmd="canvas.zoomOut" label="Zoom out">
        <Minus size={14} />
      </Tool>
      <button
        onClick={() => void flow.zoomTo(1, { duration: 200 })}
        className="h-7 w-12 rounded-[7px] font-mono text-[11.5px] text-text-2 hover:bg-surface-2 hover:text-text-1"
        aria-label="Reset zoom to 100%"
        title="Zoom to 100% (0)"
        data-testid="zoom-badge"
      >
        {Math.round(zoom * 100)}%
      </button>
      <Tool cmd="canvas.zoomIn" label="Zoom in">
        <Plus size={14} />
      </Tool>
      <Sep />
      <Tool cmd="canvas.tidy" label="Tidy up frames">
        <LayoutGrid size={14} />
      </Tool>
      <Tool cmd="label.new" label="New section label" testId="tool-label">
        <Type size={14} />
      </Tool>
      <Tool cmd="note.new" label="New note">
        <StickyNote size={14} />
      </Tool>
      <Tool cmd="card.new" label="New card">
        <AppWindow size={14} />
      </Tool>
      <Tool cmd="flow.new" label="New flow">
        <Workflow size={14} />
      </Tool>
      <Sep />
      <Tool cmd="canvas.undo" label="Undo">
        <Undo2 size={14} />
      </Tool>
      <Tool cmd="canvas.redo" label="Redo">
        <Redo2 size={14} />
      </Tool>
    </div>
  );
}
