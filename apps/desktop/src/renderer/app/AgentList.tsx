import { useEffect, useState } from "react";
import { Check, Copy, LogIn, Plus, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import type { AccountsState, AgentInfo } from "@lattiz/shared";
import { lattiz } from "../api";
import { Button, cn } from "@lattiz/ui";
import { useWorkspace } from "../stores/workspace";

/** One line of agent status, shared by Settings → Agents and onboarding (§6.4, §8.10). */
export function agentState(a: AgentInfo): { label: string; tone: "ok" | "warn" | "off" } {
  if (!a.installed) return { label: "Not installed", tone: "off" };
  if (a.id === "terminal:claude") return { label: "Ready · your Claude subscription, in a terminal", tone: "ok" };
  if (a.kind === "terminal") return { label: "Detected · runs in a terminal", tone: "ok" };
  if (a.apiKey === "saved") return { label: "Ready · API key", tone: "ok" };
  if (a.apiKey === "shell") return { label: "Ready · API key from your shell (ANTHROPIC_API_KEY)", tone: "ok" };
  if (a.apiKey === "none" && !a.signedIn) return { label: "Needs an API key", tone: "warn" };
  if (!a.signedIn) return { label: "Signed out", tone: "warn" };
  return { label: a.account ? `Signed in · ${a.account}` : "Ready", tone: "ok" };
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="flex max-w-full items-center gap-1.5 rounded-control border border-line bg-bg-1 px-2 py-1 font-mono text-[11px] text-text-2 hover:text-text-1"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      aria-label={`Copy: ${text}`}
    >
      <span className="truncate">{text}</span>
      {copied ? <Check size={11} className="shrink-0 text-state-done" /> : <Copy size={11} className="shrink-0" />}
    </button>
  );
}

/** The chat-view Claude's API key (main: agents:setApiKey). Kept in the OS keychain; never shown again. */
function ApiKeyRow({ agent }: { agent: AgentInfo }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useWorkspace.getState().toast;
  const save = (value: string | null) => {
    setSaving(true);
    lattiz
      .invoke("agents:setApiKey", { agentId: "claude-code", key: value })
      .then((agents) => {
        useWorkspace.setState({ agents });
        setKey("");
        toast(value ? "API key saved in your keychain." : "API key removed.");
      })
      .catch((err: unknown) => toast(errorText(err)))
      .finally(() => setSaving(false));
  };
  if (agent.apiKey === "saved")
    return (
      <div className="mt-2 flex items-center gap-2 text-[12px] text-text-2" data-testid="api-key">
        <span>Anthropic API key saved</span>
        <Button size="sm" variant="ghost" disabled={saving} onClick={() => save(null)}>
          <Trash2 size={12} /> Remove
        </Button>
      </div>
    );
  return (
    <form
      className="mt-2 flex flex-col gap-1"
      data-testid="api-key"
      onSubmit={(e) => {
        e.preventDefault();
        if (key.trim()) save(key.trim());
      }}
    >
      <div className="flex gap-1.5">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="sk-ant-…"
          aria-label="Anthropic API key"
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 rounded-control border border-line bg-bg-1 px-2 font-mono text-[12px] text-text-1 outline-none focus:border-line-strong"
        />
        <Button size="sm" variant="secondary" type="submit" disabled={saving || key.trim().length < 20}>
          Save key
        </Button>
      </div>
      <span className="text-[11.5px] leading-relaxed text-text-3">
        For Lattiz&apos;s chat view, billed per use by Anthropic (console.anthropic.com). To use your Claude subscription instead, start a
        Claude Code chat: it runs in its own terminal.
      </span>
    </form>
  );
}

/** Agents whose CLI can be pointed at a separate home folder (main: HOME_ENV). */
const ACCOUNT_AGENTS = new Set(["claude-code", "codex", "gemini"]);

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

/** Accounts for one agent (§9.12 AC3): add, label, switch. */
function AccountsRow({ agent, state, onChange }: { agent: AgentInfo; state: AccountsState; onChange: (s: AccountsState) => void }) {
  const mine = state.accounts.filter((x) => x.agentId === agent.id);
  const active = state.active[agent.id] ?? "";
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [switching, setSwitching] = useState(false);
  const toast = useWorkspace.getState().toast;
  const run = (p: Promise<AccountsState>) => p.then(onChange).catch((err: unknown) => toast(errorText(err)));
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-text-2" data-testid="accounts">
      <span>Account</span>
      <select
        value={active}
        disabled={switching}
        aria-label={`${agent.displayName} account`}
        className="h-7 rounded-control border border-line bg-surface px-1.5 text-[12px] text-text-1"
        onChange={(e) => {
          setSwitching(true);
          toast("Switching once running turns have finished…");
          void run(lattiz.invoke("accounts:switch", { agentId: agent.id, accountId: e.target.value || null })).finally(() =>
            setSwitching(false),
          );
        }}
      >
        <option value="">Default</option>
        {mine.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
          </option>
        ))}
      </select>
      {active && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Forget this account"
          title="Forget this account (its folder stays on disk)"
          onClick={() => void run(lattiz.invoke("accounts:remove", { id: active }))}
        >
          <Trash2 size={12} />
        </Button>
      )}
      {adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            void run(lattiz.invoke("accounts:add", { agentId: agent.id, label: label.trim() })).then(() => {
              setAdding(false);
              setLabel("");
              useWorkspace.getState().setSettingsOpen(false);
            });
          }}
        >
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Work"
            aria-label="Account label"
            className="h-7 w-28 rounded-control border border-line bg-bg-1 px-2 text-[12px] text-text-1"
          />
          <Button size="sm" variant="secondary" type="submit">
            Add and sign in
          </Button>
        </form>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Plus size={12} /> Add account
        </Button>
      )}
    </div>
  );
}

export function AgentList({ hideDemo = false, compact = false }: { hideDemo?: boolean; compact?: boolean }) {
  const agents = useWorkspace((s) => s.agents);
  const loadAgents = useWorkspace((s) => s.loadAgents);
  const signIn = useWorkspace((s) => s.signIn);
  const [checking, setChecking] = useState(false);
  const [accounts, setAccounts] = useState<AccountsState | null>(null);
  useEffect(() => {
    if (!compact) void lattiz.invoke("accounts:list").then(setAccounts);
  }, [compact]);
  const list = agents
    .filter((a) => !hideDemo || a.id !== "fake")
    // Installed first; then the rest in their built-in order.
    .sort((a, b) => Number(b.installed) - Number(a.installed));
  return (
    <div className="flex flex-col gap-2">
      {list.length === 0 && <div className="h-16 animate-pulse rounded-panel bg-surface-2" aria-label="Checking agents" />}
      {list.map((a) => {
        const st = agentState(a);
        if (compact && !a.installed && a.source === "built-in" && a.kind === "terminal") return null;
        return (
          <div
            key={a.id}
            className="flex items-start gap-3 rounded-panel border border-line bg-bg-1 p-3"
            data-testid="agent-card"
            data-agent={a.id}
          >
            <span className="mt-1 h-2.5 w-2.5 shrink-0" style={{ background: `var(--hue-${a.hue})` }} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13px] font-medium text-text-1">
                {a.displayName}
                {a.kind === "terminal" && <SquareTerminal size={12} className="text-text-3" aria-label="Terminal agent" />}
                {a.version && <span className="truncate font-mono text-[10.5px] font-normal text-text-3">{a.version}</span>}
              </div>
              <div
                className={cn(
                  "text-[12px]",
                  st.tone === "ok" ? "text-state-done" : st.tone === "warn" ? "text-state-needs-you" : "text-text-3",
                )}
                data-testid="agent-state"
              >
                {st.label}
              </div>
              {!compact && a.installed && accounts && ACCOUNT_AGENTS.has(a.id) && (
                <AccountsRow agent={a} state={accounts} onChange={setAccounts} />
              )}
              {!compact && a.installed && a.apiKey && <ApiKeyRow agent={a} />}
              {!a.installed && a.installHint && (
                <div className="mt-1.5">
                  <CopyCommand text={a.installHint} />
                </div>
              )}
            </div>
            {/* The chat-view Claude shares Claude Code's sign-in, which its card offers. */}
            {a.installed && a.canSignIn && a.id !== "claude-code" && (
              <Button size="sm" variant={a.signedIn ? "ghost" : "primary"} onClick={() => void signIn(a.id)} data-testid="sign-in">
                <LogIn size={12} /> {a.signedIn ? "Sign in again" : "Sign in"}
              </Button>
            )}
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          void loadAgents(true).finally(() => setChecking(false));
        }}
      >
        <RefreshCw size={12} className={checking ? "animate-spin" : undefined} /> {checking ? "Checking…" : "Re-check agents"}
      </Button>
    </div>
  );
}
