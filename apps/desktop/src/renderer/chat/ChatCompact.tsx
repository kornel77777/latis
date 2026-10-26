import { memo, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, MessageSquareReply, ShieldQuestion } from "lucide-react";
import { StatusDot, cn, statusLabel } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";
import { activityOf, elapsed } from "./activity";

// Semantic zoom (§8.4): what a chat looks like below 70% (condensed) and below 45% (status tile).
// Sized in canvas units so they stay readable when the canvas is scaled down.

const FALLBACK_HUE: Record<string, string> = { "claude-code": "amber-sand", codex: "slate-blue", gemini: "sky", fake: "violet" };

function useChat(chatId: string) {
  const chat = useWorkspace((s) => s.chats[chatId]);
  const agent = useWorkspace((s) => s.agents.find((a) => a.id === chat?.summary.agentId));
  const activity = useMemo(
    () => (chat ? activityOf(chat.turns, chat.events, chat.summary.status === "working" || chat.summary.status === "needs-you") : null),
    [chat],
  );
  const completed = useMemo(() => chat?.events.filter((e) => e.event.type === "turn.completed").length ?? 0, [chat]);
  return { chat, agent, activity, completed };
}

/** Re-renders every second while `active`, for elapsed timers. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Click (not drag) zooms to the chat. React Flow still gets the drag. */
function useClickToFocus(nodeId: string | undefined) {
  const down = useRef<{ x: number; y: number } | null>(null);
  const focusNode = useWorkspace((s) => s.focusNode);
  return {
    onPointerDown: (e: React.PointerEvent) => (down.current = { x: e.clientX, y: e.clientY }),
    onClick: (e: React.MouseEvent) => {
      const d = down.current;
      if (nodeId && d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) focusNode(nodeId);
    },
  };
}

function cardProps(chatId: string, status: string, agentId: string, completed: number, title: string) {
  return {
    "aria-label": `Chat: ${title}`,
    "data-testid": "chat-card",
    "data-chat-id": chatId,
    "data-status": status,
    "data-agent": agentId,
    "data-completed-turns": completed,
  };
}

export const ChatTile = memo(function ChatTile({ chatId, selected }: { chatId: string; selected: boolean }) {
  const { chat, agent, activity, completed } = useChat(chatId);
  const working = chat?.summary.status === "working" || chat?.summary.status === "needs-you";
  const now = useNow(working);
  const click = useClickToFocus(chat?.summary.nodeId);
  const markStep = useWorkspace((st) => st.markStep);
  useEffect(() => markStep("zoom"), [markStep]);
  if (!chat || !activity) return null;
  const s = chat.summary;
  const hue = agent?.hue ?? FALLBACK_HUE[s.agentId] ?? "violet";
  // When nothing's running, the start of the last reply says more than repeating the state.
  const action =
    activity.action ?? activity.lastMessage.split("\n").find((l) => l.trim()) ?? (s.status === "idle" ? "No messages yet" : "");
  return (
    <article
      {...cardProps(chatId, s.status, s.agentId, completed, s.title)}
      data-zoom="tile"
      className={cn(
        "latis-drag flex h-full w-full cursor-pointer flex-col overflow-hidden rounded-card border-2 bg-surface p-8",
        selected ? "border-line-strong" : "border-line",
        s.status === "needs-you" && "border-state-needs-you/70",
      )}
      title="Click to zoom in"
      {...click}
    >
      <div className="-mx-8 -mt-8 mb-8 h-4 shrink-0" style={{ background: `var(--hue-${hue})` }} />
      <div className="flex items-center gap-4 text-[30px] text-text-2">
        <span>{agent?.displayName ?? s.agentId}</span>
        {s.worktree && !s.worktree.removed && (
          <span className="flex items-center gap-2 text-accent">
            <GitBranch size={28} /> copy
          </span>
        )}
      </div>
      <h3 className="mt-3 line-clamp-3 text-[48px] font-semibold leading-tight text-text-1">{s.title}</h3>
      <div className="mt-auto flex items-center gap-5">
        <StatusDot status={s.status} className="!h-10 !w-10" />
        <span className="text-[40px] font-semibold text-text-1" data-testid="tile-state">
          {statusLabel[s.status]}
        </span>
        {activity.since && working && <span className="ml-auto font-mono text-[32px] text-text-3">{elapsed(activity.since, now)}</span>}
      </div>
      <p className="mt-4 truncate text-[30px] text-text-2" data-testid="tile-action">
        {action}
      </p>
      {activity.pendingRequests > 0 && (
        <div className="mt-5 flex items-center gap-3 self-start rounded-control bg-state-needs-you px-5 py-2 text-[28px] font-semibold text-bg-0">
          <ShieldQuestion size={28} /> {activity.pendingRequests} waiting for you
        </div>
      )}
    </article>
  );
});

export const ChatCondensed = memo(function ChatCondensed({ chatId, selected }: { chatId: string; selected: boolean }) {
  const { chat, agent, activity, completed } = useChat(chatId);
  const working = chat?.summary.status === "working" || chat?.summary.status === "needs-you";
  const now = useNow(working);
  const focusNode = useWorkspace((s) => s.focusNode);
  if (!chat || !activity) return null;
  const s = chat.summary;
  const hue = agent?.hue ?? FALLBACK_HUE[s.agentId] ?? "violet";
  return (
    <article
      {...cardProps(chatId, s.status, s.agentId, completed, s.title)}
      data-zoom="condensed"
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-card border bg-surface",
        selected ? "border-line-strong shadow-lift" : "border-line",
        s.status === "needs-you" && "ring-2 ring-state-needs-you/60",
      )}
      style={{ borderTop: `4px solid var(--hue-${hue})` }}
    >
      <header className="latis-drag flex h-16 shrink-0 cursor-grab items-center gap-3 border-b border-line px-5">
        <StatusDot status={s.status} className="!h-4 !w-4" />
        <span className="min-w-0 flex-1 truncate text-[20px] font-semibold text-text-1">{s.title}</span>
        <span className="shrink-0 text-[16px] text-text-3">{agent?.displayName ?? s.agentId}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
        <p className="line-clamp-3 text-[20px] leading-snug text-text-1" data-testid="condensed-message">
          {activity.lastMessage || <span className="text-text-3">No reply yet.</span>}
        </p>
        <div className="flex items-center gap-3 rounded-control bg-bg-1 px-4 py-3 text-[18px] text-text-2">
          <StatusDot status={s.status} />
          <span className="min-w-0 flex-1 truncate">{activity.action ?? statusLabel[s.status]}</span>
          {activity.since && working && <span className="font-mono text-text-3">{elapsed(activity.since, now)}</span>}
        </div>
        {activity.pendingRequests > 0 && (
          <div className="flex items-center gap-2 self-start rounded-control bg-state-needs-you px-4 py-1.5 text-[16px] font-semibold text-bg-0">
            <ShieldQuestion size={18} /> {activity.pendingRequests} waiting for you
          </div>
        )}
      </div>
      <button
        className="nodrag m-4 mt-0 flex h-14 items-center gap-3 rounded-control border border-line bg-bg-1 px-4 text-left text-[18px] text-text-3 hover:text-text-1"
        onClick={() => focusNode(s.nodeId)}
        aria-label="Zoom in to reply"
      >
        <MessageSquareReply size={20} /> Reply…
      </button>
    </article>
  );
});
