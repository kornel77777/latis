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
export function StatusDot({ status, className }: { status: StatusKind; className?: string }) {
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
          status === "working" && "animate-latis-pulse rounded-full bg-state-working",
          status === "needs-you" && "animate-latis-breathe rotate-45 rounded-[2px] bg-state-needs-you",
          status === "done" && "rounded-full bg-state-done",
          status === "error" && "rounded-[2px] bg-state-error",
        )}
      />
    </span>
  );
}

export const statusLabel = label;
