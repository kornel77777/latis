import { useEffect, useState } from "react";
import { AlarmClock, ArrowRightLeft, Clock, Repeat, X } from "lucide-react";
import type { AgentEvent, ScheduledMessage } from "@latis/shared";
import { Button, Dialog, cn } from "@latis/ui";
import { latis } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../stores/workspace";

// Send later and limit handling (§9.10), and "Continue with…" (§9.11).

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

const MIN = 60_000;
const HOUR = 60 * MIN;

function tomorrowAt9() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "in 25 min", "in 2 h 5 min", "tomorrow 09:00". */
export function relative(t: number, now = Date.now()) {
  const ms = t - now;
  if (ms <= 30_000) return "now";
  const mins = Math.round(ms / MIN);
  if (mins < 60) return `in ${mins} min`;
  if (mins < 12 * 60) return `in ${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
  const d = new Date(t);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day =
    d.toDateString() === tomorrow.toDateString()
      ? "tomorrow"
      : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${clock(t)}`;
}

function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

const REPEATS: { label: string; ms: number | null }[] = [
  { label: "Don't repeat", ms: null },
  { label: "Every 30 minutes", ms: 30 * MIN },
  { label: "Every hour", ms: HOUR },
  { label: "Every 3 hours", ms: 3 * HOUR },
  { label: "Every day", ms: 24 * HOUR },
];

type When = "30m" | "1h" | "3h" | "tomorrow" | "reset" | "custom";

/** The Send later dialog (right-click Send, or the clock button). */
export function SendLaterDialog({
  chatId,
  text,
  open,
  onClose,
}: {
  chatId: string;
  text: string;
  open: boolean;
  onClose: (sent: boolean) => void;
}) {
  const agentId = useWorkspace((s) => s.chats[chatId]?.summary.agentId);
  const resetsAt = useWorkspace((s) => (agentId ? s.usage[agentId]?.limited?.resetsAt : null));
  const [when, setWhen] = useState<When>(resetsAt ? "reset" : "1h");
  const [custom, setCustom] = useState("");
  const [repeat, setRepeat] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const options: { id: When; label: string; at?: () => number }[] = [
    { id: "30m", label: "In 30 minutes", at: () => Date.now() + 30 * MIN },
    { id: "1h", label: "In 1 hour", at: () => Date.now() + HOUR },
    { id: "3h", label: "In 3 hours", at: () => Date.now() + 3 * HOUR },
    { id: "tomorrow", label: "Tomorrow at 09:00", at: tomorrowAt9 },
    { id: "reset", label: resetsAt ? `When the limit resets (${relative(Date.parse(resetsAt))})` : "When the limit resets" },
    { id: "custom", label: "At…" },
  ];

  const schedule = async () => {
    setError(null);
    try {
      const opt = options.find((o) => o.id === when)!;
      const fireAt = when === "custom" ? Date.parse(custom) : opt.at?.();
      if (when === "custom" && (!custom || Number.isNaN(fireAt) || fireAt! < Date.now())) throw new Error("Pick a time in the future.");
      await latis.invoke("schedule:create", {
        chatId,
        text,
        ...(when === "reset" ? { onReset: true } : { fireAt: fireAt! }),
        repeatMs: repeat,
      });
      onClose(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose(false)}
      title="Send later"
      description={text.length > 120 ? `${text.slice(0, 120)}…` : text}
    >
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="When">
        {options.map((o) => (
          <label
            key={o.id}
            className={cn(
              "flex items-center gap-2 rounded-control px-2 py-1.5 text-[13px]",
              o.id === "reset" && !resetsAt ? "text-text-3" : "text-text-1 hover:bg-surface-2",
            )}
          >
            <input
              type="radio"
              name="when"
              checked={when === o.id}
              disabled={o.id === "reset" && !resetsAt}
              onChange={() => setWhen(o.id)}
              className="accent-[var(--accent)]"
            />
            {o.label}
            {o.id === "reset" && !resetsAt && <span className="text-[12px]">(only after the agent reports a limit)</span>}
          </label>
        ))}
        {when === "custom" && (
          <input
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Send at"
            className="ml-7 h-8 w-60 rounded-control border border-line bg-bg-1 px-2 text-[13px] text-text-1"
          />
        )}
      </div>
      <label className="mt-3 flex items-center gap-2 text-[13px] text-text-2">
        <Repeat size={13} />
        <select
          value={repeat ?? ""}
          onChange={(e) => setRepeat(e.target.value ? Number(e.target.value) : null)}
          aria-label="Repeat"
          className="h-8 rounded-control border border-line bg-bg-1 px-2 text-[13px] text-text-1"
        >
          {REPEATS.map((r) => (
            <option key={r.label} value={r.ms ?? ""}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="mt-2 text-[12px] text-state-error">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void schedule()} data-testid="schedule-send">
          <Clock size={13} /> Schedule
        </Button>
      </div>
    </Dialog>
  );
}

/** Messages waiting to go out, above the composer, with a countdown (§9.10 AC2). */
export function ScheduledList({ chatId }: { chatId: string }) {
  const items = useWorkspace(useShallow((s) => s.scheduled.filter((m) => m.chatId === chatId)));
  const now = useNow();
  if (!items.length) return null;
  return (
    <ul className="mb-1.5 flex flex-col gap-1" aria-label="Scheduled messages" data-testid="scheduled">
      {items.map((m: ScheduledMessage) => (
        <li key={m.id} className="flex items-center gap-2 rounded-control border border-line bg-bg-1 px-2 py-1 text-[12px]">
          <AlarmClock size={12} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-text-2" title={m.text}>
            {m.text}
          </span>
          <span className="shrink-0 text-text-3" title={new Date(m.fireAt).toLocaleString()}>
            {m.onReset ? "when the limit resets, " : ""}
            {relative(m.fireAt, now)}
            {m.repeatMs
              ? ` · repeats every ${REPEATS.find((r) => r.ms === m.repeatMs)?.label.replace(/^Every /, "") ?? `${Math.round(m.repeatMs / MIN)} min`}`
              : ""}
          </span>
          <button
            aria-label="Cancel scheduled message"
            className="rounded p-0.5 text-text-3 hover:bg-surface-2 hover:text-text-1"
            onClick={() => void latis.invoke("schedule:cancel", { id: m.id })}
          >
            <X size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Shown when the agent hit its usage limit in the latest turn (§9.10 AC3). */
export function LimitBanner({ chatId }: { chatId: string }) {
  // Returns the stored event itself, so the selector is stable between renders.
  const found = useWorkspace((s) => {
    const c = s.chats[chatId];
    if (!c) return null;
    const lastTurn = c.turns.at(-1)?.id;
    for (let i = c.events.length - 1; i >= 0; i--) {
      const se = c.events[i]!;
      if (se.turnId !== lastTurn) break;
      if (se.event.type === "rate_limited") return se;
    }
    return null;
  });
  const limit = found && { seq: found.seq, ...(found.event as Extract<AgentEvent, { type: "rate_limited" }>) };
  const [dismissed, setDismissed] = useState<number | null>(null);
  const { toast } = useWorkspace.getState();
  if (!limit || dismissed === limit.seq) return null;
  const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : null;
  return (
    <div
      className="mb-1.5 rounded-control border border-state-needs-you/40 bg-state-needs-you/10 px-3 py-2 text-[12.5px]"
      role="alert"
      data-testid="limit-banner"
    >
      <p className="text-text-1">
        {limit.message}
        {resets ? ` It resets ${relative(resets)}.` : ""}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          disabled={!resets}
          title={resets ? undefined : "The agent didn't say when the limit resets."}
          onClick={() =>
            void latis
              .invoke("schedule:create", { chatId, text: "Continue where you left off.", onReset: true })
              .then(() => {
                setDismissed(limit.seq);
                toast("Scheduled: Latis will ask it to continue when the limit resets.");
              })
              .catch((err: unknown) => toast(errorText(err)))
          }
        >
          <AlarmClock size={12} /> Send when it resets
        </Button>
        <Button size="sm" variant="primary" onClick={() => useWorkspace.setState({ handoffFor: chatId })} data-testid="limit-continue">
          <ArrowRightLeft size={12} /> Continue with another agent…
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(limit.seq)}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** "Continue with…": pick an agent, edit the brief, start the new chat beside the old one (§9.11). */
export function HandoffDialog() {
  const chatId = useWorkspace((s) => s.handoffFor);
  const chat = useWorkspace((s) => (s.handoffFor ? s.chats[s.handoffFor]?.summary : undefined));
  const agents = useWorkspace((s) => s.agents);
  const demo = useWorkspace((s) => s.demoInProjects);
  const usage = useWorkspace((s) => s.usage);
  const [brief, setBrief] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = agents.filter(
    (a) => a.kind === "structured" && a.installed && a.signedIn && a.id !== chat?.agentId && (a.id !== "fake" || demo),
  );

  useEffect(() => {
    if (!chatId) return;
    let live = true;
    void latis
      .invoke("handoff:brief", { chatId })
      .then((r) => live && setBrief(r.brief))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
      setBrief(null);
      setError(null);
      setAgentId("");
    };
  }, [chatId]);

  const target = agentId || (choices.find((a) => !usage[a.id]?.limited) ?? choices[0])?.id || "";
  const close = () => useWorkspace.setState({ handoffFor: null });
  const start = async () => {
    if (!chatId || !brief?.trim() || !target) return;
    setBusy(true);
    try {
      const { node, chat: created, frame } = await latis.invoke("handoff:start", { chatId, agentId: target, brief });
      useWorkspace.getState().addCreatedChat(node, created, frame);
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(chatId)}
      onOpenChange={(o) => !o && close()}
      title="Continue with another agent"
      description="A new chat starts beside this one, in the same folder, with this brief. Edit it before sending."
      width={640}
    >
      {choices.length === 0 ? (
        <p className="text-[13px] text-text-2">No other signed-in agent. Set one up in Settings → Agents.</p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="handoff">
          <label className="flex items-center gap-2 text-[13px] text-text-2">
            Continue with
            <select
              value={target}
              onChange={(e) => setAgentId(e.target.value)}
              aria-label="Agent"
              className="h-8 rounded-control border border-line bg-bg-1 px-2 text-[13px] text-text-1"
            >
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                  {usage[a.id]?.limited ? " (at its limit)" : ""}
                </option>
              ))}
            </select>
          </label>
          <textarea
            value={brief ?? "Writing the brief…"}
            disabled={brief === null}
            onChange={(e) => setBrief(e.target.value)}
            aria-label="Handoff brief"
            rows={16}
            className="w-full rounded-control border border-line bg-bg-1 px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text-1 outline-none focus:border-line-strong"
          />
          {error && <p className="text-[12px] text-state-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!brief?.trim() || busy} onClick={() => void start()} data-testid="handoff-start">
              <ArrowRightLeft size={13} /> Start the new chat
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
