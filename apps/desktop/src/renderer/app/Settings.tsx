import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button, Dialog, cn } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";
import { AgentList } from "./AgentList";

const sections = ["Agents", "Notifications"] as const;

/** Settings (§8.11). M2 ships Agents and Notifications; the other sections come with their milestones. */
export function SettingsDialog() {
  const open = useWorkspace((s) => s.settingsOpen);
  const setOpen = useWorkspace((s) => s.setSettingsOpen);
  const [section, setSection] = useState<(typeof sections)[number]>("Agents");
  return (
    <Dialog open={open} onOpenChange={setOpen} title="Settings" width={720}>
      <div className="flex gap-4">
        <nav className="flex w-36 shrink-0 flex-col gap-0.5" aria-label="Settings sections">
          {sections.map((s) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={cn(
                "h-8 rounded-control px-2 text-left text-[13px]",
                section === s ? "bg-surface-2 text-text-1" : "text-text-2 hover:bg-surface-2 hover:text-text-1",
              )}
            >
              {s}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">{section === "Agents" ? <AgentsSection /> : <NotificationsSection />}</div>
      </div>
    </Dialog>
  );
}

function AgentsSection() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const agents = useWorkspace((s) => s.agents);
  useEffect(() => {
    void latis.invoke("agents:manifestErrors").then(setErrors);
  }, [agents]);
  return (
    <div className="flex flex-col gap-4">
      <AgentList />
      <section className="rounded-panel border border-line p-3 text-[12px] text-text-2">
        <h3 className="mb-1 text-[13px] font-medium text-text-1">Add an agent</h3>
        <p className="leading-relaxed">
          Drop a JSON manifest in the agents folder to add any ACP agent or terminal CLI without an app update, then Re-check agents.
        </p>
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => void latis.invoke("agents:openFolder")}>
          <FolderOpen size={12} /> Open agents folder
        </Button>
        {Object.entries(errors).map(([file, why]) => (
          <p key={file} className="mt-2 text-state-error" data-testid="manifest-error">
            <span className="font-mono">{file}</span>: {why}
          </p>
        ))}
      </section>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-panel border border-line p-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
      <span>
        <span className="block text-[13px] text-text-1">{label}</span>
        <span className="block text-[12px] text-text-3">{hint}</span>
      </span>
    </label>
  );
}

function NotificationsSection() {
  const prefs = useWorkspace((s) => s.prefs);
  const setPrefs = useWorkspace((s) => s.setPrefs);
  if (!prefs) return null;
  return (
    <div className="flex flex-col gap-2">
      <Toggle
        label="When an agent needs you"
        hint="Approvals, questions, plans and usage limits. Permission notifications have Allow and Deny on macOS."
        checked={prefs.notifyNeedsYou}
        onChange={(v) => void setPrefs({ notifyNeedsYou: v })}
      />
      <Toggle
        label="When a chat finishes"
        hint="Skipped while Latis is focused and the chat is on screen."
        checked={prefs.notifyFinished}
        onChange={(v) => void setPrefs({ notifyFinished: v })}
      />
    </div>
  );
}
