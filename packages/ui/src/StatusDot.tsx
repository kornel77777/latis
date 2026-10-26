import { cn } from "./cn";

export type StatusKind = "idle" | "working" | "needs-you" | "done" | "error";

const label: Record<StatusKind, string> = {
  idle: "Idle",
  working: "Working",
  "needs-you": "Needs you",
  done: "Done",
  error: "Error",
};

/** State is never colour alone (SPEC §8.12): each state also has a distinct shape and a label. */
/** `still`: no animation (legends and counts of zero; a running animation costs CPU even when nothing happens). */
export function StatusDot({ status, className, still = false }: { status: StatusKind; className?: string; still?: boolean }) {
  return (
    <span
      role="img"
      aria-label={label[status]}
      title={label[status]}
      className={cn("relative inline-flex h-2.5 w-2.5 shrink-0", className)}
    >
      <span
        className={cn(
          "absolute inset-0",
          status === "idle" && "rounded-full border-[1.5px] border-state-idle",
          status === "working" && cn("rounded-full bg-state-working", !still && "animate-latis-pulse"),
          status === "needs-you" && cn("rotate-45 rounded-[2px] bg-state-needs-you", !still && "animate-latis-breathe"),
          status === "done" && "rounded-full bg-state-done",
          status === "error" && "rounded-[2px] bg-state-error",
        )}
      />
    </span>
  );
}

export const statusLabel = label;
