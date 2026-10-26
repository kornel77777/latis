import { useState } from "react";
import { ArrowRightLeft, ChevronDown, Gauge, ShieldAlert, ShieldCheck, ShieldHalf, ShieldOff } from "lucide-react";
import type { AgentModel, ChatSummary } from "@latis/shared";
import { Menu, MenuItem, MenuLabel, MenuSeparator, cn } from "@latis/ui";
import { useWorkspace } from "../stores/workspace";

type Mode = ChatSummary["permissionMode"];

export const MODES: { id: Mode; label: string; hint: string; icon: typeof ShieldCheck }[] = [
  { id: "read-only", label: "Read-only", hint: "Reads only. No edits or commands.", icon: ShieldCheck },
  { id: "ask", label: "Ask", hint: "Asks before edits and commands.", icon: ShieldHalf },
  { id: "auto-edit", label: "Auto-edit", hint: "Edits freely, asks before commands.", icon: ShieldAlert },
  { id: "full-auto", label: "Full-auto", hint: "Runs everything except the always-ask list.", icon: ShieldOff },
];

const chipClass =
  "flex h-6 items-center gap-1 rounded-control px-1.5 text-[11.5px] font-medium text-text-2 hover:bg-surface-2 hover:text-text-1 data-[state=open]:bg-surface-2";

function useModels(agentId: string): { models: AgentModel[] | undefined; load: () => void; error: string | null } {
  const models = useWorkspace((s) => s.models[agentId]);
  const loadModels = useWorkspace((s) => s.loadModels);
  const [error, setError] = useState<string | null>(null);
  return {
    models,
    error,
    load: () => {
      setError(null);
      loadModels(agentId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    },
  };
}

export function ModelPicker({ chat, agentLabel }: { chat: ChatSummary; agentLabel: string }) {
  const { models, load, error } = useModels(chat.agentId);
  const setOptions = useWorkspace((s) => s.setChatOptions);
  const current = models?.find((m) => m.id === (chat.model ?? "default"));
  const label = current?.label ?? chat.model ?? "Default";
  return (
    <Menu
      align="start"
      onOpenChange={(open) => open && load()}
      trigger={
        <button className={chipClass} aria-label="Model" data-testid="model-picker">
          <span className="text-text-3">{agentLabel} ·</span> {label}
          <ChevronDown size={11} />
        </button>
      }
    >
      <MenuLabel>Model</MenuLabel>
      {!models && !error && <MenuItem disabled>Loading…</MenuItem>}
      {error && <MenuItem disabled>Couldn't load models</MenuItem>}
      {models?.map((m) => (
        <MenuItem key={m.id} onSelect={() => void setOptions(chat.id, { model: m.id })}>
          <span className="flex-1">{m.label}</span>
          {(chat.model ?? "default") === m.id && <span className="text-accent">●</span>}
        </MenuItem>
      ))}
      {chat.role !== "conductor" && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => useWorkspace.setState({ handoffFor: chat.id })}>
            <ArrowRightLeft size={13} /> Continue with another agent…
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

export function ReasoningPicker({ chat }: { chat: ChatSummary }) {
  const { models, load } = useModels(chat.agentId);
  const setOptions = useWorkspace((s) => s.setChatOptions);
  const levels = models?.find((m) => m.id === (chat.model ?? "default"))?.reasoningLevels;
  if (models && !levels?.length) return null;
  return (
    <Menu
      align="start"
      onOpenChange={(open) => open && load()}
      trigger={
        <button className={chipClass} aria-label="Reasoning effort">
          <Gauge size={12} /> {chat.reasoning ?? "Default effort"}
          <ChevronDown size={11} />
        </button>
      }
    >
      <MenuLabel>Reasoning effort</MenuLabel>
      <MenuItem onSelect={() => void setOptions(chat.id, { reasoning: null })}>
        <span className="flex-1">Default</span>
        {!chat.reasoning && <span className="text-accent">●</span>}
      </MenuItem>
      {(levels ?? []).map((l) => (
        <MenuItem key={l} onSelect={() => void setOptions(chat.id, { reasoning: l })}>
          <span className="flex-1 capitalize">{l}</span>
          {chat.reasoning === l && <span className="text-accent">●</span>}
        </MenuItem>
      ))}
    </Menu>
  );
}

export function PermissionPicker({ chat, unenforceable }: { chat: ChatSummary; unenforceable: Mode[] }) {
  const setOptions = useWorkspace((s) => s.setChatOptions);
  const mode = MODES.find((m) => m.id === chat.permissionMode) ?? MODES[2]!;
  return (
    <Menu
      align="start"
      trigger={
        <button
          className={cn(chipClass, chat.permissionMode === "full-auto" && "text-state-working")}
          aria-label="Permission mode"
          data-testid="permission-picker"
        >
          <mode.icon size={12} /> {mode.label}
          <ChevronDown size={11} />
        </button>
      }
    >
      <MenuLabel>Permissions</MenuLabel>
      {MODES.map((m) => (
        <MenuItem key={m.id} onSelect={() => void setOptions(chat.id, { permissionMode: m.id })}>
          <m.icon size={13} />
          <span className="flex flex-1 flex-col">
            <span>{m.label}</span>
            <span className="text-[11px] text-text-3">
              {m.hint}
              {unenforceable.includes(m.id) && " The always-ask list is only checked when the agent asks first."}
            </span>
          </span>
          {chat.permissionMode === m.id && <span className="text-accent">●</span>}
        </MenuItem>
      ))}
    </Menu>
  );
}
