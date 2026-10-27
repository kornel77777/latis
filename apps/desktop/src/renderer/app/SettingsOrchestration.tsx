import { useEffect, useState } from "react";
import { BookOpen, Download, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import type { McpConnection, McpConnectionInput, McpImportCandidate, Skill } from "@lattiz/shared";
import { Button, cn } from "@lattiz/ui";
import { lattiz } from "../api";
import { useWorkspace } from "../stores/workspace";

// Settings for M5: the Conductor (§10.2), MCP connections (§9.15) and skills (§9.14).

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

const input = "h-8 w-full rounded-control border border-line bg-bg-1 px-2 text-[13px] text-text-1 outline-none focus:border-line-strong";
const area =
  "w-full rounded-control border border-line bg-bg-1 px-2 py-1.5 font-mono text-[12px] text-text-1 outline-none focus:border-line-strong";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-text-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-text-3">{hint}</span>}
    </label>
  );
}

export function ConductorSection() {
  const conductor = useWorkspace((s) => Object.values(s.chats).find((c) => c.summary.role === "conductor")?.summary);
  const agents = useWorkspace((s) => s.agents);
  const demo = useWorkspace((s) => s.demoInProjects);
  const prefs = useWorkspace((s) => s.prefs);
  const { setPrefs, toast, focusChat, setSettingsOpen } = useWorkspace.getState();
  const choices = agents.filter((a) => (a.kind === "structured" || a.id === "terminal:claude") && a.installed && (a.id !== "fake" || demo));
  return (
    <div className="flex flex-col gap-4 text-[13px]" data-testid="conductor-settings">
      <p className="leading-relaxed text-text-2">
        The Conductor is a pinned chat that can start chats with your agents, wait for them, read what they did and write notes on the
        canvas. Any other chat can get the same tools from its ⋯ menu.
      </p>
      {conductor ? (
        <>
          <Field label="Agent" hint="Changing it starts a new Conductor conversation.">
            <select
              className={input}
              value={conductor.agentId}
              aria-label="Conductor agent"
              onChange={(e) =>
                void lattiz
                  .invoke("conductor:setAgent", { agentId: e.target.value })
                  .then(() => toast("The Conductor will use this agent from its next message."))
                  .catch((err: unknown) => toast(errorText(err)))
              }
            >
              {choices.map((a) => (
                <option key={a.id} value={a.id} disabled={!a.signedIn}>
                  {a.displayName}
                  {a.signedIn ? "" : " (not signed in)"}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void lattiz.invoke("conductor:openPrefs")}>
              <Pencil size={12} /> Edit my preferences (AGENTS.md)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSettingsOpen(false);
                focusChat(conductor.id);
              }}
            >
              Show the Conductor
            </Button>
          </div>
        </>
      ) : (
        <p className="text-text-3">The Conductor appears on the canvas once an agent is set up.</p>
      )}
      {prefs && (
        <Field label="Most chats one chat can run at once" hint="Applies to the Conductor and to chats with workspace tools.">
          <input
            type="number"
            min={1}
            max={20}
            className={cn(input, "w-24")}
            value={prefs.maxSpawned}
            aria-label="Most chats one chat can run at once"
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (n >= 1 && n <= 20) void setPrefs({ maxSpawned: n });
            }}
          />
        </Field>
      )}
    </div>
  );
}

// ── Connections ──────────────────────────────────────────────────────────────

function parsePairs(text: string, sep: RegExp): Record<string, string> | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return undefined;
  return Object.fromEntries(
    lines.map((l) => {
      const m = sep.exec(l);
      if (!m) throw new Error(`"${l.trim()}" needs a name and a value.`);
      return [l.slice(0, m.index).trim(), l.slice(m.index + m[0].length).trim()];
    }),
  );
}

function ConnectionForm({ initial, onDone }: { initial: McpConnection | null; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(initial?.transport ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join("\n"));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [shared, setShared] = useState(initial?.shared ?? true);
  const [error, setError] = useState<string | null>(null);
  const keep = (keys: string[] | undefined) => (keys?.length ? `Saved: ${keys.join(", ")}. Leave empty to keep them.` : undefined);

  const save = async () => {
    try {
      const envObj = parsePairs(env, /=/);
      const headerObj = parsePairs(headers, /:\s?/);
      const payload: McpConnectionInput = {
        ...(initial && { id: initial.id }),
        name: name.trim(),
        transport,
        shared,
        ...(transport === "stdio"
          ? {
              command: command.trim(),
              args: args
                .split("\n")
                .map((a) => a.trim())
                .filter(Boolean),
              ...(envObj && { env: envObj }),
            }
          : { url: url.trim(), ...(headerObj && { headers: headerObj }) }),
      };
      await lattiz.invoke("mcp:save", payload);
      await useWorkspace.getState().loadConnections();
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line p-3" data-testid="connection-form">
      <div className="flex gap-3">
        <Field label="Name">
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="github" aria-label="Name" />
        </Field>
        <Field label="Type">
          <select className={input} value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "http")} aria-label="Type">
            <option value="stdio">Command (stdio)</option>
            <option value="http">URL (HTTP)</option>
          </select>
        </Field>
      </div>
      {transport === "stdio" ? (
        <>
          <Field label="Command">
            <input
              className={cn(input, "font-mono")}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
              aria-label="Command"
            />
          </Field>
          <Field label="Arguments, one per line">
            <textarea
              className={area}
              rows={2}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="-y&#10;@modelcontextprotocol/server-github"
              aria-label="Arguments"
            />
          </Field>
          <Field label="Environment, NAME=value per line" hint={keep(initial?.envKeys) ?? "Stored encrypted in your keychain."}>
            <textarea
              className={area}
              rows={2}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder="GITHUB_TOKEN=…"
              aria-label="Environment"
            />
          </Field>
        </>
      ) : (
        <>
          <Field label="URL">
            <input
              className={cn(input, "font-mono")}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
              aria-label="URL"
            />
          </Field>
          <Field label="Headers, Name: value per line" hint={keep(initial?.headerKeys) ?? "Stored encrypted in your keychain."}>
            <textarea
              className={area}
              rows={2}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder="Authorization: Bearer …"
              aria-label="Headers"
            />
          </Field>
        </>
      )}
      <label className="flex items-center gap-2 text-[13px] text-text-1">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="accent-[var(--accent)]" />
        Share with every chat
        <span className="text-[12px] text-text-3">Otherwise, turn it on per chat from the chat&apos;s ⋯ menu.</span>
      </label>
      {error && <p className="text-[12px] text-state-error">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!name.trim()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [found, setFound] = useState<McpImportCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const { toast, loadConnections } = useWorkspace.getState();
  useEffect(() => {
    void lattiz
      .invoke("mcp:importScan")
      .then(setFound)
      .catch((err: unknown) => toast(errorText(err)));
  }, [toast]);
  const total = Object.values(chosen).flat().length;
  const run = async () => {
    let n = 0;
    for (const [path, names] of Object.entries(chosen)) if (names.length) n += (await lattiz.invoke("mcp:import", { path, names })).length;
    await loadConnections();
    toast(n === 1 ? "Imported 1 connection." : `Imported ${n} connections.`);
    onDone();
  };
  if (!found) return <p className="text-[12px] text-text-3">Looking for MCP servers in other apps…</p>;
  if (!found.length)
    return (
      <div className="rounded-panel border border-line p-3 text-[12px] text-text-3">
        No MCP servers found in Claude Desktop, Claude Code, Cursor, Gemini CLI, Codex or VS Code.{" "}
        <button className="text-accent hover:underline" onClick={onDone}>
          Close
        </button>
      </div>
    );
  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line p-3" data-testid="import-panel">
      <p className="text-[12px] text-text-2">
        Pick what to copy. Lattiz copies exactly what&apos;s shown; values of the listed keys are copied too and stored encrypted.
      </p>
      {found.map((c) => (
        <div key={c.path}>
          <div className="mb-1 text-[12px] font-medium text-text-1">
            {c.source} <span className="font-mono font-normal text-text-3">{c.path}</span>
          </div>
          {c.servers.map((s) => {
            const on = chosen[c.path]?.includes(s.name) ?? false;
            return (
              <label key={s.name} className={cn("flex items-start gap-2 py-1 text-[12px]", s.exists && "opacity-50")}>
                <input
                  type="checkbox"
                  disabled={s.exists}
                  checked={on}
                  className="mt-0.5 accent-[var(--accent)]"
                  onChange={() =>
                    setChosen((prev) => ({
                      ...prev,
                      [c.path]: on ? (prev[c.path] ?? []).filter((n) => n !== s.name) : [...(prev[c.path] ?? []), s.name],
                    }))
                  }
                />
                <span className="min-w-0">
                  <span className="text-text-1">{s.name}</span>
                  {s.exists && <span className="text-text-3"> (already added)</span>}
                  <span className="block truncate font-mono text-text-3">
                    {s.transport === "http" ? s.url : [s.command, ...s.args].join(" ")}
                  </span>
                  {(s.envKeys.length > 0 || s.headerKeys.length > 0) && (
                    <span className="block text-text-3">Keys: {[...s.envKeys, ...s.headerKeys].join(", ")}</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={!total} onClick={() => void run()}>
          Import {total || ""}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ConnectionsSection() {
  const list = useWorkspace((s) => s.connections);
  const [editing, setEditing] = useState<McpConnection | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const { toast, loadConnections } = useWorkspace.getState();
  const update = async (c: McpConnection, shared: boolean) => {
    try {
      await lattiz.invoke("mcp:save", {
        id: c.id,
        name: c.name,
        transport: c.transport,
        shared,
        ...(c.transport === "stdio" ? { command: c.command ?? "", args: c.args } : { url: c.url ?? "" }),
      });
      await loadConnections();
    } catch (err) {
      toast(errorText(err));
    }
  };
  return (
    <div className="flex flex-col gap-3" data-testid="connections">
      <p className="text-[13px] leading-relaxed text-text-2">
        MCP servers your agents can use. Shared ones go to every chat whose agent supports MCP; changes apply when a chat&apos;s agent next
        starts.
      </p>
      {list.length === 0 && !editing && <p className="text-[12px] text-text-3">No connections yet.</p>}
      {list.map((c) =>
        editing !== "new" && editing?.id === c.id ? (
          <ConnectionForm key={c.id} initial={c} onDone={() => setEditing(null)} />
        ) : (
          <div key={c.id} className="flex items-center gap-3 rounded-panel border border-line px-3 py-2" data-testid="connection">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-text-1">{c.name}</div>
              <div className="truncate font-mono text-[11.5px] text-text-3">
                {c.transport === "http" ? c.url : [c.command, ...c.args].join(" ")}
                {c.envKeys.length + c.headerKeys.length > 0 && ` · ${c.envKeys.length + c.headerKeys.length} key(s)`}
              </div>
            </div>
            <label className="flex items-center gap-1.5 text-[12px] text-text-2">
              <input
                type="checkbox"
                checked={c.shared}
                onChange={(e) => void update(c, e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Every chat
            </label>
            <Button size="icon" variant="ghost" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
              <Pencil size={13} />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Remove ${c.name}`}
              onClick={() =>
                void lattiz
                  .invoke("mcp:remove", { id: c.id })
                  .then(loadConnections)
                  .catch((err: unknown) => toast(errorText(err)))
              }
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ),
      )}
      {editing === "new" && <ConnectionForm initial={null} onDone={() => setEditing(null)} />}
      {importing && <ImportPanel onDone={() => setImporting(false)} />}
      {!editing && !importing && (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus size={12} /> Add connection
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setImporting(true)}>
            <Download size={12} /> Import from other apps…
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Skills ───────────────────────────────────────────────────────────────────

export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const { toast, loadSkills } = useWorkspace.getState();
  const refresh = () => void loadSkills(null, true).then(setSkills);
  useEffect(refresh, [loadSkills]);
  return (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="skills">
      <p className="leading-relaxed text-text-2">
        Reusable instructions. Type <span className="font-mono text-text-1">/name</span> in any composer to send one with your message. A
        skill is a markdown file in your skills folder (or a folder with a <span className="font-mono">SKILL.md</span>); a project can have
        its own in <span className="font-mono">.lattiz/skills/</span>.
      </p>
      {skills?.length === 0 && <p className="text-[12px] text-text-3">No skills yet. Add a .md file to the folder, then come back.</p>}
      {skills?.map((s) => (
        <div key={s.path} className="flex items-baseline gap-2 border-b border-line pb-2 last:border-b-0">
          <BookOpen size={12} className="shrink-0 self-center text-text-3" />
          <span className="font-mono text-text-1">/{s.name}</span>
          <span className="min-w-0 truncate text-[12px] text-text-3">{s.description}</span>
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => void lattiz.invoke("skills:openFolder")}>
          <FolderOpen size={12} /> Open skills folder
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void lattiz
              .invoke("skills:import")
              .then((s) => {
                if (s) toast(`Added /${s.name}.`);
                refresh();
              })
              .catch((err: unknown) => toast(errorText(err)))
          }
        >
          <Download size={12} /> Import a SKILL.md folder…
        </Button>
        <Button size="sm" variant="ghost" onClick={refresh}>
          Refresh
        </Button>
      </div>
    </div>
  );
}
