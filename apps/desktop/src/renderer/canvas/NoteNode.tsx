import { memo, useEffect, useRef } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { Download, MoreHorizontal, Pencil, StickyNote, Trash2 } from "lucide-react";
import { Button, Menu, MenuItem, MenuSeparator, cn } from "@latis/ui";
import { latis } from "../api";
import { Markdown } from "../markdown/Markdown";
import { useWorkspace, type FlowNode } from "../stores/workspace";
import { useZoomLevel } from "./zoom";

// Markdown notes on the canvas (§9.13): rendered preview, double-click or Enter to edit.

const titleOf = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.replace(/^#+\s*/, "") || "Untitled note";

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps<FlowNode>) {
  const text = String((data as { text?: string }).text ?? "");
  const editing = useWorkspace((s) => s.editingNote === id);
  const level = useZoomLevel();
  const area = useRef<HTMLTextAreaElement>(null);
  const { updateNote, deleteNodes } = useWorkspace.getState();
  const setEditing = (on: boolean) => useWorkspace.setState({ editingNote: on ? id : null });

  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);

  if (level === "tile") {
    return (
      <article
        data-testid="note"
        data-zoom="tile"
        className="latis-drag flex h-full w-full flex-col rounded-card border-2 border-line bg-surface p-8"
      >
        <StickyNote size={40} className="text-text-3" />
        <h3 className="mt-4 line-clamp-3 text-[44px] font-semibold leading-tight text-text-1">{titleOf(text)}</h3>
      </article>
    );
  }

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={220} minHeight={140} />
      <article
        aria-label={`Note: ${titleOf(text)}`}
        data-testid="note"
        tabIndex={0}
        onKeyDown={(e) => {
          if (!editing && e.key === "Enter" && e.target === e.currentTarget) {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className={cn(
          "flex h-full w-full flex-col overflow-hidden rounded-card border bg-surface",
          selected ? "border-line-strong shadow-lift" : "border-line",
        )}
        style={{ borderTop: "2px solid var(--text-3)" }}
      >
        <header className="latis-drag flex h-8 shrink-0 cursor-grab items-center gap-1.5 px-2.5 text-[11.5px] text-text-3 active:cursor-grabbing">
          <StickyNote size={12} /> <span className="flex-1">Note</span>
          <Menu
            trigger={
              <Button variant="ghost" size="icon" aria-label="Note menu" className="nodrag !h-6 !w-6">
                <MoreHorizontal size={13} />
              </Button>
            }
          >
            <MenuItem onSelect={() => setEditing(true)}>
              <Pencil size={13} /> Edit
            </MenuItem>
            <MenuItem onSelect={() => void latis.invoke("note:export", { nodeId: id })}>
              <Download size={13} /> Export as .md…
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={() => void deleteNodes([id])}>
              <Trash2 size={13} /> Delete
            </MenuItem>
          </Menu>
        </header>
        {editing ? (
          <textarea
            ref={area}
            value={text}
            onChange={(e) => updateNote(id, e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
            placeholder="# Title&#10;&#10;Write in Markdown: lists, - [ ] tasks, `code`, tables, links."
            aria-label="Note text"
            data-testid="note-editor"
            className="nodrag nowheel selectable min-h-0 flex-1 resize-none bg-transparent px-3 pb-3 font-mono text-[12.5px] leading-relaxed text-text-1 outline-none placeholder:text-text-3"
          />
        ) : (
          <div
            className="nowheel selectable min-h-0 flex-1 cursor-text overflow-y-auto px-3 pb-3 text-[13.5px] leading-relaxed text-text-1"
            onDoubleClick={() => setEditing(true)}
            data-testid="note-preview"
          >
            {text.trim() ? <Markdown text={text} /> : <p className="text-text-3">Double-click to write.</p>}
          </div>
        )}
      </article>
    </>
  );
});
