import { useState } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { DEFAULT_ALWAYS_ASK, matchAlwaysAsk, type AgentInfo } from "@latis/shared";
import { Button, cn } from "@latis/ui";
import { MODES } from "../chat/pickers";
import { useWorkspace } from "../stores/workspace";

// Settings → Permissions (§8.11, §9.8): the mode new chats start in and the always-ask list.

const input =
  "h-8 min-w-0 flex-1 rounded-control border border-line bg-bg-1 px-2 font-mono text-[12px] text-text-1 outline-none focus:border-line-strong";

/** How far the always-ask list reaches for an agent (registry `unenforceable`). */
function coverage(a: AgentInfo): { text: string; ok: boolean } {
  if (a.kind === "terminal") return { text: "Not checked: the terminal is the agent's own UI.", ok: false };
  if (a.unenforceable.includes("full-auto")) return { text: "Checked when the agent asks before running a command.", ok: false };
  return { text: "Every command is checked, in every mode.", ok: true };
}

export function PermissionsSection() {
  const prefs = useWorkspace((s) => s.prefs);
  const agents = useWorkspace((s) => s.agents);
  const setPrefs = useWorkspace((s) => s.setPrefs);
  const [draft, setDraft] = useState("");
  const [trial, setTrial] = useState("");
  if (!prefs) return null;
  const list = prefs.alwaysAsk;
  const save = (alwaysAsk: string[]) => void setPrefs({ alwaysAsk });
  const add = () => {
    const p = draft.trim().replace(/\s+/g, " ");
    if (!p) return;
    if (!list.includes(p)) save([...list, p]);
    setDraft("");
  };
  const hit = trial.trim() ? matchAlwaysAsk(trial, list) : null;
  const isDefault = list.length === DEFAULT_ALWAYS_ASK.length && DEFAULT_ALWAYS_ASK.every((p) => list.includes(p));
  return (
    <div className="flex flex-col gap-5 text-[13px]" data-testid="permissions-settings">
      <section className="flex flex-col gap-1.5">
        <h3 className="text-[13px] font-medium text-text-1">New chats start in</h3>
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Default mode for new chats">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={prefs.defaultPermissionMode === m.id}
              onClick={() => void setPrefs({ defaultPermissionMode: m.id })}
              className={cn(
                "flex items-start gap-2 rounded-control border px-2.5 py-2 text-left",
                prefs.defaultPermissionMode === m.id ? "border-accent bg-surface-2" : "border-line hover:bg-surface-2",
              )}
            >
              <m.icon size={14} className="mt-0.5 shrink-0 text-text-2" />
              <span>
                <span className="block text-text-1">{m.label}</span>
                <span className="block text-[11.5px] text-text-3">{m.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="text-[12px] text-text-3">Each chat can still change its own mode from its header.</p>
      </section>

      <section className="flex flex-col gap-2">
        <div>
          <h3 className="text-[13px] font-medium text-text-1">Always ask before</h3>
          <p className="text-[12px] leading-relaxed text-text-3">
            Commands that need your approval every time, even in Full-auto. A pattern matches any command that starts with its program and
            has its words in any order, so <code className="font-mono">rm -rf</code> also catches <code className="font-mono">rm -fr</code>{" "}
            and <code className="font-mono">sudo rm -Rf</code>, including inside <code className="font-mono">sh -c</code>. When in doubt,
            Latis asks.
          </p>
        </div>
        <ul className="flex flex-wrap gap-1.5" aria-label="Always-ask list" data-testid="always-ask-list">
          {list.map((p) => (
            <li
              key={p}
              className="flex h-7 items-center gap-1 rounded-control border border-line bg-bg-1 pl-2 pr-0.5 font-mono text-[12px] text-text-1"
            >
              {p}
              <button
                onClick={() => save(list.filter((x) => x !== p))}
                aria-label={`Remove ${p}`}
                className="flex h-6 w-6 items-center justify-center rounded-control text-text-3 hover:bg-surface-2 hover:text-text-1"
              >
                <X size={12} />
              </button>
            </li>
          ))}
          {!list.length && (
            <li className="text-[12px] text-state-working">The list is empty: Full-auto chats run every command without asking.</li>
          )}
        </ul>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. git push --force, terraform apply, kubectl delete"
            aria-label="Add a command pattern"
            maxLength={200}
            className={input}
          />
          <Button size="sm" variant="secondary" type="submit" disabled={!draft.trim() || list.length >= 100}>
            <Plus size={12} /> Add
          </Button>
          {!isDefault && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              onClick={() => save([...DEFAULT_ALWAYS_ASK])}
              title={DEFAULT_ALWAYS_ASK.join(", ")}
            >
              <RotateCcw size={12} /> Defaults
            </Button>
          )}
        </form>
        <div className="flex items-center gap-2">
          <input
            value={trial}
            onChange={(e) => setTrial(e.target.value)}
            placeholder="Try a command, e.g. cd app && npm publish"
            aria-label="Try a command"
            className={input}
          />
          <span className={cn("w-48 shrink-0 text-[12px]", hit ? "text-state-needs-you" : "text-text-3")} data-testid="always-ask-trial">
            {!trial.trim() ? "" : hit ? `Asks (matches ${hit})` : "Runs per the chat's mode"}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-medium text-text-1">Where the list applies</h3>
        {agents
          .filter((a) => a.installed && a.id !== "fake")
          .map((a) => {
            const c = coverage(a);
            return (
              <div key={a.id} className="flex items-baseline gap-2 text-[12px]">
                <span className="w-32 shrink-0 text-text-1">{a.displayName}</span>
                <span className={c.ok ? "text-text-3" : "text-state-working"}>{c.text}</span>
              </div>
            );
          })}
        {!agents.some((a) => a.installed && a.id !== "fake") && <p className="text-[12px] text-text-3">No agents are installed yet.</p>}
      </section>
    </div>
  );
}
