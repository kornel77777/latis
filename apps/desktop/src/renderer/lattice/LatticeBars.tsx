import { useMemo, useRef, useState } from "react";
import { Plus, Radio, SendHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { StatusDot, cn } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";
import { broadcast, canStart, stackAgent, targetProject } from "./collab";

// The two bars that make the lattice a place to run several agents: the agent strip (start any
// agent beside the others in one click) and the broadcast bar (one message to many agents).

/** The broadcast input, so a command can focus it. */
export const broadcastInput: { current: HTMLTextAreaElement | null } = { current: null };

/** One button per installed agent: click to stack a new chat with it into the lattice. */
export function AgentStrip({ big = false }: { big?: boolean }) {
  const agents = useWorkspace(useShallow((s) => s.agents.filter((a) => a.installed)));
  const project = useWorkspace((s) => targetProject(s));
  const projectName = useWorkspace((s) => (project ? s.projects[project]?.name : null));
  if (!agents.length) return null;
  return (
    <div className={cn("flex min-w-0 items-center", big ? "flex-wrap justify-center gap-2" : "gap-px")} data-testid="agent-strip">
      {!big && <span className="latis-caps mr-2 shrink-0 text-text-3">{projectName ? `+ in ${projectName}` : "+ agent"}</span>}
      {agents.map((a) => {
        const ok = canStart(a.id, project);
        return (
          <button
            key={a.id}
            disabled={!ok}
            onClick={() => void stackAgent(a.id, project)}
            title={
              ok ? `Start ${a.displayName}${projectName ? ` in ${projectName}` : ""}` : "Open a folder, or pick a project in the filter"
            }
            data-testid={`stack-${a.id}`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border border-line bg-surface text-text-2 transition-colors duration-fast",
              "hover:border-line-strong hover:text-text-1 disabled:pointer-events-none disabled:opacity-35",
              big
                ? "h-9 rounded-control px-3.5 text-[13px]"
                : "h-7 px-2.5 text-[12px] first-of-type:rounded-l-control last:rounded-r-control",
            )}
          >
            <span className="h-2 w-2 shrink-0" style={{ background: `var(--hue-${a.hue})` }} />
            {big && <Plus size={12} />}
            {a.displayName}
          </button>
        );
      })}
    </div>
  );
}

/** One message, sent to every selected pane (mid-turn chats are steered). */
export function BroadcastBar({ ids }: { ids: string[] }) {
  const chats = useWorkspace((s) => s.chats);
  const agents = useWorkspace((s) => s.agents);
  const targets = useMemo(
    () =>
      ids
        .filter((id) => chats[id] && agents.find((a) => a.id === chats[id]!.summary.agentId)?.kind !== "terminal")
        .map((id) => {
          const c = chats[id]!.summary;
          return { id, title: c.title, status: c.status, hue: agents.find((a) => a.id === c.agentId)?.hue ?? "violet" };
        }),
    [ids, chats, agents],
  );
  const [off, setOff] = useState<string[]>([]);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const on = targets.filter((t) => !off.includes(t.id));
  if (targets.length < 2) return null;

  const submit = () => {
    const t = text.trim();
    if (!t || !on.length) return;
    setText("");
    void broadcast(
      on.map((x) => x.id),
      t,
    );
  };

  return (
    <div className="flex shrink-0 items-start gap-2 border-t border-line bg-bg-0 px-2 py-1.5" data-testid="broadcast-bar">
      <div className="flex h-8 shrink-0 items-center gap-1.5 text-text-3">
        <Radio size={13} className="text-accent" />
        <span className="latis-caps">All</span>
      </div>
      <div className="flex max-w-[45%] shrink-0 items-center gap-px self-center overflow-x-auto" role="group" aria-label="Send to">
        {targets.map((t) => {
          const sel = !off.includes(t.id);
          return (
            <button
              key={t.id}
              aria-pressed={sel}
              onClick={() => setOff(sel ? [...off, t.id] : off.filter((x) => x !== t.id))}
              title={sel ? `Sending to ${t.title}. Click to leave it out.` : `Leaving out ${t.title}. Click to include it.`}
              data-testid="broadcast-target"
              className={cn(
                "flex h-6 max-w-40 shrink-0 items-center gap-1.5 border px-2 text-[11.5px] transition-colors duration-fast",
                sel ? "border-line-strong bg-surface-2 text-text-1" : "border-line text-text-3 line-through",
              )}
            >
              <span className="h-1.5 w-1.5 shrink-0" style={{ background: `var(--hue-${t.hue})` }} />
              <span className="truncate">{t.title}</span>
              <StatusDot status={t.status} className="h-2 w-2" />
            </button>
          );
        })}
      </div>
      <textarea
        ref={(el) => {
          ref.current = el;
          broadcastInput.current = el;
        }}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const el = e.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
            e.currentTarget.style.height = "auto";
          }
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        placeholder={`Message ${on.length} ${on.length === 1 ? "agent" : "agents"} at once…`}
        aria-label="Message every selected chat"
        data-testid="broadcast-input"
        className="min-h-8 min-w-0 flex-1 resize-none border border-line bg-surface px-2.5 py-1.5 text-[13px] text-text-1 outline-none placeholder:text-text-3 focus:border-accent"
      />
      <button
        onClick={submit}
        disabled={!text.trim() || !on.length}
        className="flex h-8 shrink-0 items-center gap-1.5 bg-accent px-3 text-[12px] font-medium text-accent-fg hover:brightness-110 disabled:opacity-35"
        data-testid="broadcast-send"
      >
        <SendHorizontal size={13} /> Send to {on.length}
      </button>
    </div>
  );
}
