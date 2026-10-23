import type { StoredEvent, Turn } from "@latis/shared";

// What a chat is doing right now, for the condensed card and the status tile (§8.4).
// Scans back through the current turn's events only, so it stays cheap at low zoom.

export interface Activity {
  /** "Editing src/api/pro.ts", "Running npm test", "Waiting for approval", … */
  action: string | null;
  /** When the running turn started, for the elapsed timer. */
  since: number | null;
  /** The latest assistant text (for the condensed card). */
  lastMessage: string;
  pendingRequests: number;
}

const short = (s: string, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `active`: the chat's status is working or needs-you (the renderer's turns don't learn their end time). */
export function activityOf(turns: Turn[], events: StoredEvent[], active: boolean): Activity {
  const turn = turns.at(-1);
  const running = active && turn ? turn : null;
  let action: string | null = null;
  let pending = 0;
  const finished = new Set<string>();
  let lastMessage = "";
  let streaming = "";
  let collecting = true;

  // Last assistant text across the whole chat.
  for (let i = events.length - 1; i >= 0 && !lastMessage; i--) {
    const e = events[i]!.event;
    if (e.type === "message.completed") lastMessage = e.text;
  }

  if (running) {
    const mine = events.filter((se) => se.turnId === running.id);
    for (let i = mine.length - 1; i >= 0; i--) {
      const e = mine[i]!.event;
      if (e.type === "tool.completed") finished.add(e.id);
      if (action === null) {
        if (e.type === "permission.requested" || e.type === "question.asked" || e.type === "plan.proposed") {
          action =
            e.type === "permission.requested"
              ? `Waiting for approval: ${short(e.command ?? e.summary, 40)}`
              : e.type === "question.asked"
                ? "Asking you a question"
                : "Plan ready for review";
        } else if (e.type === "tool.started" && !finished.has(e.id)) {
          const target =
            e.paths?.[0] ??
            (typeof (e.input as { command?: unknown })?.command === "string" ? (e.input as { command: string }).command : "");
          const verb = {
            edit: "Editing",
            read: "Reading",
            exec: "Running",
            search: "Searching",
            web: "Browsing",
            mcp: "Using",
            subagent: "Delegating",
            other: "Using",
          }[e.kind];
          action = `${verb} ${short(target || e.name)}`;
        } else if (e.type === "message.delta") {
          action = "Writing a reply";
        } else if (e.type === "thinking.delta") {
          action = "Thinking";
        } else if (e.type === "agent.status") {
          action =
            e.status === "needs-you" ? `Waiting: ${short(e.detail ?? "", 40)}` : e.status === "working" ? "Working in the terminal" : null;
        }
      }
      // Only the message being written now: stop at the last finished message or step.
      if (e.type === "message.completed" || e.type === "tool.started") collecting = false;
      if (collecting && e.type === "message.delta") streaming = e.text + streaming;
    }
    // Requests still open: those after the agent's last other event (the transcript's rule).
    for (let i = mine.length - 1; i >= 0; i--) {
      const e = mine[i]!.event;
      if (e.type === "permission.requested" || e.type === "question.asked" || e.type === "plan.proposed") pending++;
      else if (e.type !== "usage" && e.type !== "user.steered") break;
    }
  }
  return { action, since: running?.startedAt ?? null, lastMessage: streaming || lastMessage, pendingRequests: pending };
}

export function elapsed(since: number, now: number): string {
  const s = Math.max(0, Math.floor((now - since) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
