import { useEffect } from "react";
import { Columns3, LayoutGrid, PanelLeft, X } from "lucide-react";
import type { FocusView as View } from "@latis/shared";
import { Button, cn } from "@latis/ui";
import { FullChat } from "../chat/ChatNode";
import { useWorkspace } from "../stores/workspace";

// Focus mode (§8.7): chosen chats fill the screen as Grid, Stage or Columns. Esc goes back to the canvas.

const LAYOUTS: { id: View["layout"]; label: string; icon: typeof LayoutGrid }[] = [
  { id: "grid", label: "Grid", icon: LayoutGrid },
  { id: "stage", label: "Stage", icon: PanelLeft },
  { id: "columns", label: "Columns", icon: Columns3 },
];

export function FocusView({ view }: { view: View }) {
  const chats = useWorkspace((s) => s.chats);
  const { updateView, openView, closeView } = useWorkspace.getState();
  const ids = view.chatIds.filter((id) => chats[id]);

  useEffect(() => {
    // Esc in a text field leaves the field; Esc again leaves focus mode.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = e.target as HTMLElement;
      if (el.closest("[role=dialog], [role=menu]")) return;
      if (el.closest("input, textarea, [contenteditable]")) el.blur();
      else openView(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openView]);

  const stage = view.stageId && ids.includes(view.stageId) ? view.stageId : ids[0];
  const cols = Math.ceil(Math.sqrt(ids.length));

  return (
    <div
      className="flex min-w-0 flex-1 flex-col bg-bg-1"
      aria-label={`Focus: ${view.name}`}
      data-testid="focus-view"
      data-layout={view.layout}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[13px] font-semibold text-text-1">{view.name}</span>
        <span className="text-[12px] text-text-3">
          {ids.length} chat{ids.length === 1 ? "" : "s"} · Esc for the canvas
        </span>
        <div className="ml-auto flex rounded-control border border-line" role="group" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              aria-pressed={view.layout === l.id}
              onClick={() => updateView(view.id, { layout: l.id })}
              className={cn(
                "flex h-7 items-center gap-1.5 px-2.5 text-[12px]",
                view.layout === l.id ? "bg-surface-2 text-text-1" : "text-text-3 hover:text-text-1",
              )}
              data-testid={`layout-${l.id}`}
            >
              <l.icon size={13} /> {l.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" aria-label="Close this Focus view" onClick={() => closeView(view.id)}>
          <X size={14} />
        </Button>
      </div>
      {ids.length === 0 ? (
        <p className="m-auto text-[13px] text-text-3">These chats were deleted.</p>
      ) : view.layout === "grid" ? (
        <div
          className="grid min-h-0 flex-1 gap-3 p-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: "minmax(0, 1fr)" }}
        >
          {ids.map((id) => (
            <div key={id} className="min-h-0 min-w-0">
              <FullChat chatId={id} selected={false} inCanvas={false} />
            </div>
          ))}
        </div>
      ) : view.layout === "columns" ? (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {ids.map((id) => (
            <div key={id} className="h-full min-w-[420px] flex-1">
              <FullChat chatId={id} selected={false} inCanvas={false} />
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 p-3">
          <div className="min-w-0 flex-1">{stage && <FullChat chatId={stage} selected={false} inCanvas={false} />}</div>
          {ids.length > 1 && (
            <div className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto" aria-label="Side rail">
              {ids
                .filter((id) => id !== stage)
                .map((id) => (
                  <div key={id} className="flex h-80 shrink-0 flex-col gap-1">
                    <button
                      className="self-end rounded-control px-2 py-0.5 text-[11px] text-text-3 hover:bg-surface-2 hover:text-text-1"
                      onClick={() => updateView(view.id, { stageId: id })}
                    >
                      Put on stage
                    </button>
                    <div className="min-h-0 flex-1">
                      <FullChat chatId={id} selected={false} inCanvas={false} />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
