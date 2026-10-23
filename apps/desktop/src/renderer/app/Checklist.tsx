import { Check, X } from "lucide-react";
import { cn } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";

// Getting started (§8.10 step 4): five steps that tick themselves off as you do them.

const STEPS = [
  { id: "send", label: "Send a message to an agent" },
  { id: "approve", label: "Approve a request" },
  { id: "diff", label: "Open the diff of a change (Ctrl/⌘+Shift+R)" },
  { id: "zoom", label: "Zoom out to see the status tiles (−)" },
  { id: "palette", label: "Open the command palette (Ctrl/⌘+K)" },
] as const;

export function Checklist() {
  const done = useWorkspace((s) => s.prefs?.checklist);
  const onboarded = useWorkspace((s) => s.prefs?.onboarded);
  if (!done || !onboarded || done.length >= STEPS.length) return null;
  return (
    <aside
      className="absolute bottom-3 left-3 z-20 w-72 rounded-panel border border-line bg-surface p-3 shadow-lift"
      aria-label="Getting started"
      data-testid="checklist"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[13px] font-semibold text-text-1">Getting started</span>
        <span className="text-[12px] text-text-3">
          {done.length} of {STEPS.length}
        </span>
        <button
          aria-label="Dismiss getting started"
          className="ml-auto rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
          onClick={() => void useWorkspace.getState().setPrefs({ checklist: null })}
        >
          <X size={12} />
        </button>
      </div>
      <ol className="flex flex-col gap-1">
        {STEPS.map((s) => {
          const ok = done.includes(s.id);
          return (
            <li
              key={s.id}
              className={cn("flex items-center gap-2 text-[12.5px]", ok ? "text-text-3 line-through" : "text-text-1")}
              data-done={ok}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  ok ? "border-state-done bg-state-done text-bg-0" : "border-line-strong",
                )}
              >
                {ok && <Check size={10} />}
              </span>
              {s.label}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
