import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { cn } from "@latis/ui";
import { useWorkspace, type FlowNode } from "../stores/workspace";

// Section labels: big names that mark out areas of the canvas ("Agents", "Website"…).
// Double-click (or Enter when selected) to rename.

export const LabelNode = memo(function LabelNode({ id, data, selected }: NodeProps<FlowNode>) {
  const text = String((data as { text?: string }).text ?? "");
  const [editing, setEditing] = useState(!text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = (value: string) => {
    setEditing(false);
    const v = value.trim() || "Section";
    if (v !== text) useWorkspace.getState().updateNote(id, v);
  };
  return (
    <>
      <NodeResizer isVisible={selected} minWidth={140} minHeight={48} />
      <div
        data-testid="section-label"
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !editing) setEditing(true);
        }}
        className={cn(
          "latis-drag flex h-full w-full cursor-grab items-center gap-3 rounded-control border bg-surface/80 px-5 shadow-sm backdrop-blur active:cursor-grabbing",
          selected ? "border-line-strong" : "border-line",
        )}
      >
        <span className="latis-label-dot h-2.5 w-2.5 shrink-0 rounded-control bg-accent" />
        {editing ? (
          <input
            ref={input}
            autoFocus
            defaultValue={text}
            aria-label="Label"
            className="nodrag min-w-0 flex-1 bg-transparent text-[26px] font-semibold tracking-tight text-text-1 outline-none"
            onBlur={(e) => save(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="min-w-0 truncate text-[26px] font-semibold tracking-tight text-text-1">{text || "Section"}</span>
        )}
      </div>
    </>
  );
});
