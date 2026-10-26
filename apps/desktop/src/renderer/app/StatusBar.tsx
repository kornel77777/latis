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
            className="flex items-center gap-1.5 rounded-[2px] px-1 hover:bg-surface-2 hover:text-text-1"
            data-testid={`count-${k}`}
            title={k === "needs-you" ? "Jump to the next item (Ctrl+J)" : undefined}
            onClick={() => (k === "needs-you" ? jumpAttention(1) : undefined)}
          >
            <StatusDot status={k} /> {n} {statusLabel[k].toLowerCase()}
          </button>
        );
      })}
      <button
        className="flex items-center gap-1 rounded-[2px] px-1 hover:bg-surface-2 hover:text-text-1"
        onClick={() => setSidebarTab("inbox")}
      >
        Inbox {inbox}
      </button>
      <UsageMeters />
    </footer>
  );
}

const time = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
};

/** Per-agent usage as the agents report it (§9.12 AC1). Unknown is "—", never a guess. */
function UsageMeters() {
  const usage = useWorkspace((s) => s.usage);
  const agents = useWorkspace(
    useShallow((s) => s.agents.filter((a) => a.installed && a.signedIn && a.kind === "structured" && a.id !== "fake")),
  );
  return (
    <div className="ml-auto flex items-center gap-3" data-testid="usage-meters">
      {agents.map((a) => {
        const u = usage[a.id];
        const name = a.displayName.replace(/ (CLI|Code)$/, "");
        if (u?.limited)
          return (
            <span key={a.id} className="text-state-error" title={u.limited.message} data-testid={`usage-${a.id}`}>
              {name}: limit{u.limited.resetsAt ? ` · resets ${time(u.limited.resetsAt)}` : ""}
            </span>
          );
        const ws = u?.windows ?? [];
        const title = ws.map((w) => `${w.label}: ${w.usedPct ?? "—"}% used${w.resetsAt ? `, resets ${time(w.resetsAt)}` : ""}`).join("\n");
        return (
          <span key={a.id} className="text-text-3" title={title || `${a.displayName} doesn't report usage`} data-testid={`usage-${a.id}`}>
            {name}{" "}
            {ws.length ? (
              ws.map((w, i) => (
                <span key={w.id} className={(w.usedPct ?? 0) >= 90 ? "text-state-needs-you" : "text-text-2"}>
                  {i > 0 && " · "}
                  {w.label} {w.usedPct === undefined ? "—" : `${w.usedPct}%`}
                </span>
              ))
            ) : (
              <span className="text-text-2">—</span>
            )}
          </span>
        );
      })}
      <span className="text-text-3">v0.1</span>
    </div>
  );
}
