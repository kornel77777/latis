import { useEffect, useState } from "react";
import { FolderOpen, ImageIcon, X } from "lucide-react";
import type { Appearance, Theme } from "@latis/shared";
import { ACCENTS } from "./useAppearance";
import { Button, Dialog, cn } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace, type SettingsSection } from "../stores/workspace";
import { AgentList } from "./AgentList";
import { CommandsSection } from "./CommandsSettings";
import { ConductorSection, ConnectionsSection, SkillsSection } from "./SettingsOrchestration";

const sections: SettingsSection[] = ["Agents", "Conductor", "Connections", "Skills", "Commands", "Appearance", "Notifications"];
const BODY: Record<SettingsSection, () => React.ReactNode> = {
  Agents: AgentsSection,
  Conductor: ConductorSection,
  Connections: ConnectionsSection,
  Skills: SkillsSection,
  Commands: CommandsSection,
  Appearance: AppearanceSection,
  Notifications: NotificationsSection,
};

/** Settings (§8.11). Permissions, accounts and the rest come with their milestones. */
export function SettingsDialog() {
  const open = useWorkspace((s) => s.settingsOpen);
  const setOpen = useWorkspace((s) => s.setSettingsOpen);
  const section = useWorkspace((s) => s.settingsSection);
  const setSection = (settingsSection: SettingsSection) => useWorkspace.setState({ settingsSection });
  const Body = BODY[section];
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
        <div className="min-w-0 flex-1">
          <Body />
        </div>
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

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 border-b border-line py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-text-1">{label}</div>
        {hint && <div className="text-[12px] text-text-3">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="flex rounded-control border border-line" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn("h-7 px-2.5 text-[12px]", value === o.id ? "bg-surface-2 text-text-1" : "text-text-3 hover:text-text-1")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AppearanceSection() {
  const prefs = useWorkspace((s) => s.prefs);
  const theme = useWorkspace((s) => s.theme);
  const { setPrefs, setTheme, toast } = useWorkspace.getState();
  if (!prefs) return null;
  const a = prefs.appearance;
  const set = (patch: Partial<Appearance>) => void setPrefs({ appearance: { ...a, ...patch } });
  return (
    <div data-testid="appearance">
      <Row label="Theme">
        <Segmented<Theme>
          label="Theme"
          value={theme}
          options={[
            { id: "dark", label: "Dark" },
            { id: "light", label: "Light" },
            { id: "system", label: "System" },
          ]}
          onChange={(t) => void setTheme(t)}
        />
      </Row>
      <Row label="Accent">
        <div className="flex gap-1.5" role="radiogroup" aria-label="Accent">
          {Object.entries(ACCENTS).map(([id, c]) => (
            <button
              key={id}
              role="radio"
              aria-checked={a.accent === id}
              aria-label={c.label}
              title={c.label}
              onClick={() => set({ accent: id as Appearance["accent"] })}
              className="h-6 w-6 rounded-full border-2"
              style={{ background: c.dark, borderColor: a.accent === id ? "var(--text-1)" : "transparent" }}
            />
          ))}
        </div>
      </Row>
      <Row label="Interface size" hint={`${Math.round(a.uiScale * 100)}%`}>
        <input
          type="range"
          min={0.8}
          max={1.4}
          step={0.05}
          value={a.uiScale}
          aria-label="Interface size"
          onChange={(e) => set({ uiScale: Number(e.target.value) })}
          className="w-40 accent-[var(--accent)]"
        />
      </Row>
      <Row label="Chat text size" hint={`${a.chatTextSize}px`}>
        <input
          type="range"
          min={12}
          max={20}
          step={1}
          value={a.chatTextSize}
          aria-label="Chat text size"
          onChange={(e) => set({ chatTextSize: Number(e.target.value) })}
          className="w-40 accent-[var(--accent)]"
        />
      </Row>
      <Row label="Density">
        <Segmented
          label="Density"
          value={a.density}
          options={[
            { id: "comfortable", label: "Comfortable" },
            { id: "compact", label: "Compact" },
          ]}
          onChange={(density) => set({ density })}
        />
      </Row>
      <Row label="Cards" hint={a.cardStyle === "glass" ? `See-through: ${Math.round(a.cardOpacity * 100)}% opaque` : undefined}>
        {a.cardStyle === "glass" && (
          <input
            type="range"
            min={0.5}
            max={1}
            step={0.05}
            value={a.cardOpacity}
            aria-label="Card opacity"
            onChange={(e) => set({ cardOpacity: Number(e.target.value) })}
            className="w-28 accent-[var(--accent)]"
          />
        )}
        <Segmented
          label="Card style"
          value={a.cardStyle}
          options={[
            { id: "solid", label: "Solid" },
            { id: "glass", label: "Glass" },
          ]}
          onChange={(cardStyle) => set({ cardStyle })}
        />
      </Row>
      <Row label="Canvas grid">
        <Segmented
          label="Canvas grid"
          value={a.grid}
          options={[
            { id: "dots", label: "Dots" },
            { id: "lines", label: "Lines" },
            { id: "none", label: "None" },
          ]}
          onChange={(grid) => set({ grid })}
        />
      </Row>
      <Row label="Wallpaper" hint="An image behind the canvas.">
        {a.wallpaper && (
          <Button size="sm" variant="ghost" onClick={() => set({ wallpaper: null })}>
            <X size={12} /> Remove
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void latis
              .invoke("appearance:pickWallpaper")
              .then((w) => w && set({ wallpaper: w }))
              .catch((err: unknown) => toast(err instanceof Error ? err.message : String(err)))
          }
        >
          <ImageIcon size={12} /> Choose…
        </Button>
      </Row>
      <Row label="Reduce motion" hint="Also follows your system setting.">
        <input
          type="checkbox"
          checked={a.reduceMotion}
          onChange={(e) => set({ reduceMotion: e.target.checked })}
          aria-label="Reduce motion"
          className="accent-[var(--accent)]"
        />
      </Row>
    </div>
  );
}
