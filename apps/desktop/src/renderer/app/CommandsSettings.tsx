import { useMemo, useState } from "react";
import { AlertTriangle, Plus, RotateCcw, Search, X } from "lucide-react";
import { Button, cn } from "@latis/ui";
import { chordOf, display } from "../commands/keys";
import { allCommands, bindingsOf, conflicts, runCommand, type Command } from "../commands/registry";
import { useWorkspace } from "../stores/workspace";

// Settings → Commands: every command, its shortcuts, and where it works. Click + and press keys to
// add a shortcut; × removes one; ↺ goes back to the default.

const SCOPE_LABEL = { global: "Anywhere", canvas: "Canvas", lattice: "Lattice" } as const;

function Recorder({ onChord, onCancel }: { onChord: (chord: string) => void; onCancel: () => void }) {
  return (
    <button
      autoFocus
      className="h-6 rounded-[6px] border border-accent bg-accent/10 px-2 text-[11.5px] text-accent outline-none"
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return onCancel();
        const chord = chordOf(e.nativeEvent);
        if (chord) onChord(chord);
      }}
      onBlur={onCancel}
      data-testid="shortcut-recorder"
    >
      Press keys… (Esc to cancel)
    </button>
  );
}

export function CommandsSection() {
  const prefs = useWorkspace((s) => s.prefs);
  const setPrefs = useWorkspace((s) => s.setPrefs);
  const [q, setQ] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const overrides = useMemo(() => prefs?.keybindings ?? {}, [prefs?.keybindings]);
  const list = allCommands();
  const clash = useMemo(() => conflicts(list, overrides), [list, overrides]);
  const shown = list.filter((c) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return [c.title, c.category, c.id, ...bindingsOf(c, overrides).map((k) => display(k))].some((x) => x.toLowerCase().includes(needle));
  });
  const groups = [...new Set(shown.map((c) => c.category))];
  const save = (id: string, keys: string[] | null) => {
    const rest = Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== id));
    void setPrefs({ keybindings: keys === null ? rest : { ...rest, [id]: keys } });
  };
  const isDefault = (c: Command) => !(c.id in overrides);

  return (
    <div className="flex flex-col gap-3" data-testid="commands">
      <div className="flex items-center gap-2">
        <label className="flex h-8 flex-1 items-center gap-2 rounded-control border border-line bg-bg-1 px-2 focus-within:border-line-strong">
          <Search size={13} className="text-text-3" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search commands or shortcuts"
            aria-label="Search commands"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-text-1 outline-none placeholder:text-text-3"
          />
        </label>
        <Button size="sm" variant="ghost" disabled={!Object.keys(overrides).length} onClick={() => void setPrefs({ keybindings: {} })}>
          <RotateCcw size={12} /> Reset all
        </Button>
      </div>
      <div className="max-h-[56vh] overflow-y-auto pr-1">
        {groups.map((g) => (
          <section key={g} className="mb-3">
            <h3 className="sticky top-0 z-10 bg-surface py-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">{g}</h3>
            <table className="w-full text-[13px]">
              <tbody>
                {shown
                  .filter((c) => c.category === g)
                  .map((c) => {
                    const keys = bindingsOf(c, overrides);
                    const bad = clash.get(c.id);
                    return (
                      <tr key={c.id} className="group border-b border-line last:border-b-0" data-testid="command-row" data-command={c.id}>
                        <td className="py-1.5 pr-2">
                          <button className="text-left text-text-1 hover:text-accent" title="Run it now" onClick={() => runCommand(c.id)}>
                            {c.title}
                          </button>
                        </td>
                        <td className="w-20 py-1.5 text-[11.5px] text-text-3">{SCOPE_LABEL[c.scope ?? "global"]}</td>
                        <td className="w-[46%] py-1.5">
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            {bad && (
                              <span
                                title={`Also used by another command: ${bad.map((k) => display(k)).join(", ")}`}
                                className="text-state-needs-you"
                              >
                                <AlertTriangle size={12} />
                              </span>
                            )}
                            {keys.map((k) => (
                              <span
                                key={k}
                                className={cn(
                                  "inline-flex h-6 items-center gap-1 rounded-[6px] border bg-bg-1 pl-1.5 pr-0.5 font-mono text-[11.5px] text-text-1",
                                  bad?.includes(k) ? "border-state-needs-you/60" : "border-line",
                                )}
                                data-testid="shortcut"
                              >
                                {display(k)}
                                <button
                                  aria-label={`Remove ${display(k)} from ${c.title}`}
                                  className="rounded p-0.5 text-text-3 opacity-0 hover:text-text-1 group-hover:opacity-100 focus:opacity-100"
                                  onClick={() =>
                                    save(
                                      c.id,
                                      keys.filter((x) => x !== k),
                                    )
                                  }
                                >
                                  <X size={10} />
                                </button>
                              </span>
                            ))}
                            {recording === c.id ? (
                              <Recorder
                                onChord={(chord) => {
                                  setRecording(null);
                                  if (!keys.includes(chord)) save(c.id, [...keys, chord].slice(-4));
                                }}
                                onCancel={() => setRecording(null)}
                              />
                            ) : (
                              <button
                                aria-label={`Add a shortcut to ${c.title}`}
                                className="flex h-6 w-6 items-center justify-center rounded-[6px] text-text-3 opacity-60 hover:bg-surface-2 hover:text-text-1 group-hover:opacity-100"
                                onClick={() => setRecording(c.id)}
                                data-testid="add-shortcut"
                              >
                                <Plus size={12} />
                              </button>
                            )}
                            <button
                              aria-label={`Reset ${c.title} to its default shortcut`}
                              title="Back to the default"
                              className={cn(
                                "flex h-6 w-6 items-center justify-center rounded-[6px] text-text-3 hover:bg-surface-2 hover:text-text-1",
                                isDefault(c) && "invisible",
                              )}
                              onClick={() => save(c.id, null)}
                            >
                              <RotateCcw size={11} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </section>
        ))}
        {!shown.length && <p className="py-6 text-center text-[13px] text-text-3">No command matches “{q}”.</p>}
      </div>
      <p className="text-[12px] text-text-3">
        Canvas and lattice shortcuts only work in that view, and plain keys never fire while you type. Every command is also in ⌘K.
      </p>
    </div>
  );
}
