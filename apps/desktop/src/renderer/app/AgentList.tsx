import { useState } from "react";
import { Check, Copy, LogIn, RefreshCw, SquareTerminal } from "lucide-react";
import type { AgentInfo } from "@latis/shared";
import { Button, cn } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";

/** One line of agent status, shared by Settings → Agents and onboarding (§6.4, §8.10). */
export function agentState(a: AgentInfo): { label: string; tone: "ok" | "warn" | "off" } {
  if (!a.installed) return { label: "Not installed", tone: "off" };
  if (a.kind === "terminal") return { label: "Detected · runs in a terminal", tone: "ok" };
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

export function AgentList({ hideDemo = false, compact = false }: { hideDemo?: boolean; compact?: boolean }) {
  const agents = useWorkspace((s) => s.agents);
  const loadAgents = useWorkspace((s) => s.loadAgents);
  const signIn = useWorkspace((s) => s.signIn);
  const [checking, setChecking] = useState(false);
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
            <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: `var(--hue-${a.hue})` }} />
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
              {!a.installed && a.installHint && (
                <div className="mt-1.5">
                  <CopyCommand text={a.installHint} />
                </div>
              )}
            </div>
            {a.installed && a.canSignIn && (
              <Button size="sm" variant={a.signedIn ? "ghost" : "primary"} onClick={() => void signIn(a.id)} data-testid="sign-in">
                <LogIn size={12} /> {a.signedIn ? "Switch account" : "Sign in"}
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
