import { Bot } from "lucide-react";
import { MenuItem, MenuLabel } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";

/** "New chat with…" entries: ready agents first, then ones that need installing or signing in. */
export function AgentMenuItems({ onPick, includeDemo = true }: { onPick: (agentId: string) => void; includeDemo?: boolean }) {
  const agents = useWorkspace((s) => s.agents);
  const list = agents.filter((a) => includeDemo || a.id !== "fake");
  return (
    <>
      <MenuLabel>New chat with</MenuLabel>
      {list.length === 0 && <MenuItem disabled>Checking agents…</MenuItem>}
      {list.map((a) => {
        const ready = a.installed && (a.signedIn || a.id === "fake");
        return (
          <MenuItem key={a.id} disabled={!a.installed} onSelect={() => onPick(a.id)}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--hue-${a.hue})` }} />
            <span className="flex flex-1 flex-col">
              <span>{a.displayName}</span>
              {!a.installed && <span className="font-mono text-[10.5px] text-text-3">{a.installHint ?? "Not installed"}</span>}
              {a.installed && !ready && <span className="text-[10.5px] text-text-3">Signed out · sign in from Settings → Agents</span>}
            </span>
            {a.id === "fake" && <Bot size={12} className="text-text-3" />}
          </MenuItem>
        );
      })}
    </>
  );
}
