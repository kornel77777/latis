import { StatusDot, statusLabel, type StatusKind } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";
import { useShallow } from "zustand/react/shallow";

const shown: StatusKind[] = ["working", "needs-you", "done", "error"];

export function StatusBar() {
  const statuses = useWorkspace(useShallow((s) => Object.values(s.chats).map((c) => c.summary.status)));
  const inbox = useWorkspace((s) => s.attention.length);
  const { jumpAttention, setSidebarTab } = useWorkspace(
    useShallow((s) => ({ jumpAttention: s.jumpAttention, setSidebarTab: s.setSidebarTab })),
  );
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-bg-0 px-3 text-[11px] text-text-2" aria-label="Status">
      {shown.map((k) => {
        const n = statuses.filter((s) => s === k).length;
        return (
          <button
            key={k}
            className="flex items-center gap-1.5 rounded px-1 hover:bg-surface-2 hover:text-text-1"
            data-testid={`count-${k}`}
            title={k === "needs-you" ? "Jump to the next item (Ctrl+J)" : undefined}
            onClick={() => (k === "needs-you" ? jumpAttention(1) : undefined)}
          >
            <StatusDot status={k} /> {n} {statusLabel[k].toLowerCase()}
          </button>
        );
      })}
      <button className="flex items-center gap-1 rounded px-1 hover:bg-surface-2 hover:text-text-1" onClick={() => setSidebarTab("inbox")}>
        Inbox {inbox}
      </button>
      <span className="ml-auto text-text-3">Usage meters arrive in M6 · v0.1</span>
    </footer>
  );
}
