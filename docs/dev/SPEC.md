# Lattiz — Product & Technical Specification

> **Name:** Lattiz
> **Version:** 0.1 (draft for implementation) · October 2026
> **One-liner:** Mission control for your coding agents. Run Claude Code, Codex, Gemini and any other agent side by side on one calm, beautiful canvas, then review and land their work safely.

---

## 0. How to use this document (instructions for Claude Code)

1. **Build in milestone order (§17).** Do not start a milestone until the previous one's exit criteria pass. Each milestone must leave the app runnable.
2. **Verify every external interface before coding against it.** CLI flags, SDK package names, JSON event shapes and protocols in this spec are *starting points*, not truth. Agent CLIs change weekly. For each adapter, read the current official docs and `--help`, capture a real event stream, and record findings in `docs/adapters/<agent>.md` before writing the adapter.
3. **Keep three living files at the repo root:**
   - `PROGRESS.md`: what's done, what's next, known issues.
   - `DECISIONS.md`: any choice made where this spec was silent or ambiguous (one short entry each: context, decision, why).
   - `docs/adapters/*.md`: verified integration notes per agent.
4. **When the spec is ambiguous,** pick the simplest option consistent with the principles in §1 and log it in `DECISIONS.md`. Don't stop to ask unless a choice is irreversible.
5. **Tests are part of "done"** (see §16). Every feature lands with tests or an explicit note why not.
6. **Branding:** never use third-party logos or trademarks as the app's own branding. Agent names (e.g. "Claude Code", "Codex") may appear as plain-text labels for the agent being used.
7. **TypeScript strict mode everywhere.** No `any` without a comment explaining why.

---

## 1. Product summary

Lattiz is a **local-first desktop app** (Windows, macOS, Linux) where a developer runs many AI coding agents at once on a single infinite canvas. Each agent works in a project folder (optionally in its own git worktree). The user sees every agent's state at a glance, steers them, reviews their diffs in one place, and can orchestrate them, either by talking to a built-in conductor agent or by wiring agents into visual pipelines ("flows").

Lattiz is **not** an AI model and never resells tokens. It drives the agent CLIs/SDKs the user already has, with the user's own accounts. Prompts go from the user's machine straight to the provider.

### 1.1 Principles

| # | Principle | What it means in practice |
|---|---|---|
| P1 | **Calm** | No noise. Motion and colour only signal state changes. Quiet chats fade back; chats that need you come forward. |
| P2 | **Glanceable** | From any zoom level the user can answer "who's working, who's done, who needs me?" in under two seconds. |
| P3 | **Safe by default** | Every change is reviewable and reversible. Parallel agents never overwrite each other. |
| P4 | **Open** | Any agent can be added through an adapter or a manifest. Any agent can be the orchestrator. |
| P5 | **Keyboard-first, mouse-friendly** | Everything reachable via shortcuts and the command palette; everything also discoverable with the mouse. |
| P6 | **Local-first & private** | Data lives on disk in a documented folder. No telemetry unless opted in. |
| P7 | **Fast** | Hard performance budgets (§14). Fifty agents must not make the canvas stutter. |

### 1.2 Goals (v1)

- **G1** Run any mix of agents in parallel, each isolated from the others.
- **G2** Know instantly which agents are working, finished, erroring or waiting on you.
- **G3** Review, accept, partially accept or revert agent changes from one queue.
- **G4** Orchestrate: a conductor agent that spawns and coordinates other agents, plus visual flows.
- **G5** A distinctive, polished UI that feels better than a terminal grid.
- **G6** Bring-your-own accounts; zero proxying of prompts.

### 1.3 Non-goals (v1)

- Not a full code editor or IDE (read-only file viewer + diff viewer; "Open in editor" hands off to VS Code / Cursor / Zed etc.).
- No cloud sync, accounts system, or multi-user collaboration.
- No native mobile app (a LAN-only phone web UI is a stretch goal, §17 M7).
- No hosted model inference.

---

## 2. Competitive position: where Lattiz is better

Existing tools in this space (e.g. Morphy, Conductor, Parallel Code, CodeGrid and the agents' own desktop apps) prove the canvas/side-by-side idea. Lattiz's differentiators:

| Gap in existing tools | Lattiz's answer | Spec |
|---|---|---|
| Reviewing agent output means opening each chat | **Review Inbox**: every turn's diff across all agents in one queue; accept/revert per file or per hunk | §9.5 |
| Isolation is opt-in, so agents clobber each other | **Worktree-by-default** when ≥2 chats share a repo, plus pre-merge conflict detection | §9.3 |
| Agent integrations are closed and hard-coded | **Open adapter interface + Agent Client Protocol (ACP) support + JSON manifests**; adding an agent needs no app release | §6 |
| Orchestration is locked to one built-in assistant | **Workspace MCP server**: *any* agent (Claude Code, Codex…) can list, spawn, message and read other chats | §10 |
| Zoomed out, chat cards become unreadable | **Semantic zoom**: below 45% zoom, chats collapse into status tiles (agent, state, last action, elapsed) | §8.4 |
| "Needs you" moments get missed | **Attention system**: global inbox, `Ctrl+J` jump-to-next, OS notifications, dock badge | §8.6 |
| Usage limits ambush you | **Usage meter** per provider with reset times; auto-schedule or hand off when a limit hits | §9.10–9.12 |
| Switching agent mid-task loses context | **Handoff**: "Continue with…" transfers a compact summary + current diff to another agent | §9.11 |
| Hard to see what happened in a long run | **Timeline** per chat with every step, checkpoint and file change; scrub and restore | §9.4 |

---

## 3. Users & core scenarios

**Primary persona:** a solo builder or indie developer with one or two AI subscriptions (e.g. Claude and ChatGPT), working on 2–6 projects, comfortable with git, frustrated by terminal-tab juggling.

**Secondary persona:** a "vibecoder" who is less fluent with git and terminals and wants agents to do the work while they watch and approve.

### Core scenarios (each must be fully achievable by end of M6)

- **S1: Parallel feature work.** Open repo → spawn Claude Code on "pricing page" and Codex on "checkout API" → both run in separate worktrees → user gets notified as each finishes → reviews both diffs in the Review Inbox → merges both into the main branch.
- **S2: Steering.** While an agent is mid-turn, user types a correction; it's queued and delivered at the agent's next step without stopping it.
- **S3: Permission round-trip.** Agent asks to run `npm install`; the request appears inline in the chat *and* in the Inbox; user approves from either place (or from a notification).
- **S4: Conductor.** User tells the conductor: "Have three agents each review the auth module from different angles and summarise where they agree." Conductor spawns three chats, waits, reads results, writes a summary note.
- **S5: Limit hit.** Claude hits its usage limit mid-task. User clicks "Continue with Codex"; a new Codex chat starts in the same worktree with a summary of what was done and what's left.
- **S6: Overnight flow.** A scheduled flow runs every morning at 08:00: one agent checks dependency updates, another writes a summary, the result lands in a note awaiting approval.

---

## 4. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Electron** (latest stable) + **electron-vite** | Chosen over Tauri: agent SDKs, `node-pty` and MCP SDK are Node-native; faster to build. Accept the bundle size. |
| Language | **TypeScript** (strict) | Shared types package between main/preload/renderer. |
| UI | **React 19**, **Zustand** (state), **Tailwind CSS v4**, **Radix UI** primitives, **Motion** (framer-motion), **lucide-react** icons | |
| Canvas | **@xyflow/react** (React Flow, MIT) | Nodes = chats/cards/terminals/notes/frames; edges = flow arrows. Custom node renderers. |
| Terminal | **xterm.js** (+ fit, webgl, search, web-links, unicode11 addons) + **node-pty** in main | |
| Code/diff view | **CodeMirror 6** + `@codemirror/merge` | Lighter than Monaco; read-only viewer + side-by-side/unified diff. |
| Markdown | **react-markdown** + **remark-gfm** + **Shiki** | Shiki highlighting in a worker. |
| Long lists | **react-virtuoso** | Virtualised transcripts and inbox. |
| Storage | **SQLite** via **better-sqlite3** + **drizzle-orm** (migrations) | One DB file in the data dir. |
| File watching | **chokidar** | |
| Git | Shell out to the user's `git` via **execa** | Git ≥ 2.30 required for worktree features; detect and degrade gracefully. |
| Agent integration | Claude Agent SDK (TS), Codex app-server (JSON-RPC over stdio), ACP TypeScript SDK, PTY fallback | **Verify package names/versions** (see §0.2). |
| MCP | **@modelcontextprotocol/sdk** | Both client (connections) and server (Workspace MCP). |
| Validation | **zod** | All IPC payloads and adapter events validated at the boundary. |
| Secrets | Electron **safeStorage** (OS keychain / DPAPI / libsecret) | |
| Packaging | **electron-builder**, **electron-updater** (GitHub Releases) | Code signing + macOS notarization in M7. |
| Tests | **Vitest**, **Playwright** (Electron), recorded fixtures | |
| Lint/format | ESLint (typescript-eslint), Prettier | CI on GitHub Actions: lint, typecheck, unit, e2e (Linux), build all OSes. |

---

## 5. Architecture

```
┌──────────────────────────── Renderer (sandboxed, no Node) ────────────────────────────┐
│  React app · Canvas (React Flow) · Chat cards · Terminal views (xterm) · Docks        │
│  Zustand stores ← event stream (batched per animation frame)                          │
└───────────────────────────────▲───────────────────────────┬───────────────────────────┘
                                │ typed IPC (zod-validated) │
┌───────────────────────────────┴── Preload: window.lattiz ─▼───────────────────────────┐
└───────────────────────────────▲───────────────────────────┬───────────────────────────┘
┌──────────────────────────────── Main process (AppCore) ───────────────────────────────┐
│ AgentRuntime ── AdapterRegistry ── SessionSupervisor ──► agent child processes        │
│ PtyService      GitService (worktrees, checkpoints, diffs)    FileWatcher             │
│ WorkspaceStore (SQLite)   EventLog   AttentionService   UsageService                  │
│ McpHub (client connections)   WorkspaceMcpServer (127.0.0.1 + token / stdio shim)     │
│ FlowEngine   Scheduler   CardHost (card:// protocol)   Notifications   Updater        │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Process rules

- **Renderer:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP. UI only.
- **Preload:** exposes one typed object `window.lattiz` generated from the IPC contract. Nothing else.
- **Main:** owns all side effects. Agents run as child processes supervised by `SessionSupervisor`. **An adapter or agent crash must never crash the app**: the chat moves to `error` state with a "Restart" action.
- Heavy CPU work (diff computation on huge files, Shiki highlighting) runs in worker threads / web workers.

### 5.2 IPC contract

- Single source file: `packages/shared/src/ipc-contract.ts`, defining every channel with a zod schema for request, response and event payloads.
- Two shapes: `invoke` (request/response) and `subscribe` (event streams).
- Main → renderer events are **coalesced per 16 ms** per chat (streaming text deltas are concatenated) to keep the renderer smooth.
- Every payload is validated on receipt; invalid payloads are logged and dropped, never thrown into React.

---

## 6. Agent adapter layer

The heart of the app. All agents, regardless of how they're integrated, look identical to the rest of the app.

### 6.1 Adapter interface

```ts
export interface AgentAdapter {
  id: string;                     // "claude-code", "codex", "gemini", "acp:<name>", "terminal:<name>"
  displayName: string;
  hue: string;                    // tag colour token for this agent (no logos)
  capabilities: AgentCapabilities;

  detect(): Promise<DetectResult>;          // installed? version? binary path?
  authStatus(): Promise<AuthStatus>;        // signed in? which account? api key?
  login?(): Promise<LoginHandle>;           // runs the agent's OWN login flow in a PTY
  listModels(): Promise<ModelInfo[]>;       // incl. reasoning levels per model
  startSession(opts: SessionOptions): Promise<AgentSession>;
  resumeSession?(nativeSessionId: string, opts: SessionOptions): Promise<AgentSession>;
  terminalCommand(opts: SessionOptions & { nativeSessionId?: string }): PtySpec; // "open as terminal"
  usage?(): Promise<UsageSnapshot>;         // plan limits & reset times, if obtainable
}

export interface AgentSession {
  id: string;
  nativeSessionId?: string;                 // the agent's own conversation id, for resume
  send(turn: UserTurn): Promise<void>;      // text + images + file refs
  steer?(text: string): Promise<void>;      // deliver at next step without interrupting
  interrupt(): Promise<void>;
  respond(requestId: string, response: PermissionResponse | QuestionAnswer | PlanDecision): Promise<void>;
  setModel?(model: string, reasoning?: string): Promise<void>;
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  onEvent(listener: (e: AgentEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}

export interface AgentCapabilities {
  streaming: boolean; steering: boolean; images: boolean; resume: boolean;
  permissions: "native" | "emulated" | "none";
  plans: boolean; questions: boolean; subagents: boolean;
  mcp: boolean; reasoningLevels: boolean; usageReporting: boolean; nativeTerminal: boolean;
}

export interface SessionOptions {
  cwd: string; model?: string; reasoning?: string;
  permissionMode: PermissionMode;           // "read-only" | "ask" | "auto-edit" | "full-auto"
  alwaysAsk: string[];                      // command patterns that always need approval
  systemPromptAppend?: string;              // brief/job/skills injected here
  mcpServers?: McpServerConfig[];
  env?: Record<string, string>;
}
```

### 6.2 Normalised event schema

Every adapter maps its native stream onto this union (validated with zod):

```ts
type AgentEvent =
  | { type: "session.started"; nativeSessionId?: string; model: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; text: string }
  | { type: "thinking.delta"; text: string }
  | { type: "tool.started"; id: string; kind: ToolKind; name: string; input: unknown; paths?: string[]; parentId?: string }
  | { type: "tool.completed"; id: string; status: "ok" | "error" | "denied"; output?: unknown }
  | { type: "file.changed"; path: string; change: "created" | "modified" | "deleted" }
  | { type: "permission.requested"; id: string; kind: ToolKind; summary: string; command?: string; paths?: string[]; reason?: string }
  | { type: "question.asked"; id: string; question: string; options?: string[] }
  | { type: "plan.proposed"; id: string; markdown: string }
  | { type: "subagent.started"; id: string; parentToolId: string; prompt: string }
  | { type: "subagent.completed"; id: string; report: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "rate_limited"; resetsAt?: string; message: string }
  | { type: "turn.completed"; status: "ok" | "interrupted" | "error"; durationMs: number }
  | { type: "error"; message: string; recoverable: boolean };

type ToolKind = "read" | "edit" | "exec" | "search" | "web" | "mcp" | "subagent" | "other";
```

All events are appended to the **EventLog** (§7) and are the single source of truth for rendering a chat. A transcript can be fully re-rendered from its events.

### 6.3 Adapters to ship

> Integration methods below are the **intended** approach; verify each against current docs (§0.2) and record the result.

| Adapter | Preferred integration | Fallback | Auth | Milestone |
|---|---|---|---|---|
| **Claude Code** | Claude Agent SDK (TypeScript) with streaming input | Headless CLI: `claude -p` with stream-JSON input/output | The user's existing Claude Code sign-in, or `ANTHROPIC_API_KEY` | M1 |
| **Codex** | `codex app-server` (JSON-RPC over stdio, the protocol the IDE extension uses) | `codex exec --json` per turn, resuming by session id | The user's `codex login`, or `OPENAI_API_KEY` | M2 |
| **Gemini CLI** | ACP mode | Stream-JSON output mode | The CLI's own Google sign-in or API key | M2 |
| **Generic ACP** | Any ACP-speaking agent, defined by a manifest (§6.4) | none | Agent's own | M2 |
| **Terminal-only** | Any CLI in a PTY (Copilot CLI, Grok CLI, OpenCode, Aider…) until a structured mode is verified | none | Agent's own | M2 |
| **OpenAI-compatible "Native agent"** | Built-in minimal agent loop (tools: read, write, edit, glob, grep, bash) over any OpenAI-compatible endpoint (OpenRouter, Ollama, LM Studio, custom) | none | API key / local | M7 (stretch) |

**Terminal-only adapter status detection:** treat as `working` while output is flowing; `idle` after 1.5 s of silence *and* a prompt regex match (configurable per manifest); `needs-you` when output matches approval patterns (e.g. `(y/n)`, `Allow`, `Approve`). Capabilities: `permissions: "none"`, `streaming: false` (raw terminal is the UI).

### 6.4 Agent manifests (add agents without an app release)

JSON files in `<dataDir>/agents/*.json`:

```json
{
  "id": "acp:my-agent",
  "displayName": "My Agent",
  "protocol": "acp",                // "acp" | "terminal"
  "command": "my-agent",
  "args": ["--acp"],
  "detect": { "versionArgs": ["--version"] },
  "login": { "args": ["login"] },
  "promptRegex": "^> $",            // terminal protocol only
  "hue": "violet"
}
```

Settings → Agents shows built-in and manifest agents with Detected / Not installed / Signed out status, an Install hint, and a Sign in button.

### 6.5 Compliance & credentials (must-follow)

- **Never read, copy or proxy another tool's credential files.** Let each agent's own CLI/SDK handle its sign-in; Lattiz only launches its login flow in a PTY and checks status via the tool itself.
- **Always support API-key mode** for every provider that offers one.
- **Before any public distribution,** review each provider's current terms for third-party clients. In particular, check Anthropic's current policy on third-party products offering consumer Claude subscription login (including products built on the Claude Agent SDK) and OpenAI's equivalent for Codex. Record findings in `DECISIONS.md`. If a subscription path isn't permitted for distributed apps, ship with: (a) driving the user's own locally installed CLI under its own auth, where permitted, and (b) API-key mode.

### 6.6 FakeAdapter (for tests and demos)

A scripted adapter that replays event sequences from fixture files (`fixtures/fake/*.jsonl`) with configurable timing, including permission requests, file edits (actually writes to the temp repo), rate limits and crashes. Required from M0; all e2e tests use it.

---

## 7. Data model

All state lives in the **data directory**:
- Windows `%APPDATA%\Lattiz`, macOS `~/Library/Application Support/Lattiz`, Linux `$XDG_CONFIG_HOME/lattiz` (default `~/.config/lattiz`).
- Contents: `lattiz.db` (SQLite), `cards/` (one folder per card), `agents/` (manifests), `skills/`, `backgrounds/`, `logs/`, `worktrees/` (default worktree location; configurable to live next to the repo instead).

### 7.1 Tables (sketch; refine in drizzle schema)

```
projects      (id, name, color, folder_path, created_at, archived_at)
canvases      (id, name, sort, viewport_json)
nodes         (id, canvas_id, project_id?, type, x, y, w, h, z, data_json, created_at, deleted_at)
              -- type: chat | terminal | browser | card | note | frame | image | flow
edges         (id, canvas_id, source_node, source_handle, target_node, target_handle, mode, data_json)
              -- mode: every | free | wait_all | approval
chats         (id, node_id, agent_id, model, reasoning, permission_mode, cwd, worktree_id?,
               native_session_id?, title, title_locked, status, created_at, last_activity_at)
turns         (id, chat_id, seq, user_text, started_at, ended_at, status, checkpoint_before, checkpoint_after)
events        (chat_id, seq, ts, turn_id, type, payload_json)  -- append-only; PK (chat_id, seq)
worktrees     (id, project_id, path, branch, base_ref, created_at, merged_at, removed_at)
checkpoints   (id, chat_id, turn_id, git_ref, created_at)
attention     (id, chat_id, kind, ref_id, created_at, resolved_at)
               -- kind: permission | question | plan | finished | error | rate_limited | flow_gate
cards         (id, node_id, title, dir, refresh_script?, network_allow_json, created_at)
card_data     (card_id, key, value_json)
flows         (id, node_id, name, brief, schedule_cron?, max_handoffs, created_at)
flow_runs     (id, flow_id, started_at, ended_at, status, trigger, log_json)
scheduled_messages (id, chat_id, text, run_at, repeat_rule?, condition?)  -- condition: "limit_reset"
mcp_servers   (id, name, transport, config_json, enabled, share_with_all_chats)
skills        (id, name, body_md, created_at)
usage_samples (provider, account, ts, window, used, limit, resets_at)
settings      (key, value_json)
deleted_items (id, entity, payload_json, deleted_at)  -- soft-delete, restorable 7 days
```

### 7.2 Persistence rules

- Canvas changes are debounced (300 ms) and written in a transaction. If a write fails, show a non-blocking banner and keep retrying; never lose in-memory state.
- Events are written synchronously in batches every 250 ms (and on turn end).
- Transcripts from agent-native stores (e.g. `~/.claude`, `~/.codex`) are **not** duplicated beyond our event log; resume uses `native_session_id`.
- Soft delete everything user-visible; restore from command palette for 7 days; `Ctrl+Z` undo stack per canvas (50 steps).
- Export/backup: Settings → Data → "Export workspace" produces a zip of the data dir (excluding secrets).

---

## 8. UI/UX specification

### 8.1 Visual language (original, not borrowed)

Mood: **"Observatory at night."** Deep graphite surfaces, crisp type, a single luminous accent, and state colours that glow softly. Dark-first; full light theme with equal care.

**Design tokens** (CSS variables, defined in `packages/ui/tokens.css`):

| Token | Dark | Light |
|---|---|---|
| `--bg-0` (app) | `#0A0C0F` | `#F6F7F9` |
| `--bg-1` (canvas) | `#0E1114` | `#EEF0F3` |
| `--surface` (cards) | `#151A1F` | `#FFFFFF` |
| `--surface-glass` | `rgba(21,26,31,0.72)` + 20px blur | `rgba(255,255,255,0.78)` + 20px blur |
| `--border` | `rgba(255,255,255,0.07)` | `rgba(15,20,25,0.08)` |
| `--text-1 / -2 / -3` | `#E9ECEF / #A4ABB5 / #69717C` | `#11151A / #4A525C / #8A929C` |
| `--accent` (default "Aurora") | `#5EEAD4` | `#0F9F8F` |
| `--state-working` | `#F6B94C` (soft pulse) | `#C98A10` |
| `--state-needs-you` | `#FF7A66` (breathing glow) | `#E0503B` |
| `--state-done` | `#46D99A` | `#1E9E64` |
| `--state-error` | `#F2557A` | `#D23560` |
| `--state-idle` | `--text-3` | `--text-3` |

- **Accent choices:** Aurora (teal), Nova (indigo), Ember (orange), Bloom (pink), Moss (green), Mono (white/black).
- **Agent hues:** each agent gets a hue tag (chip + 2px card top border), e.g. Claude Code = amber-sand, Codex = slate-blue, Gemini = sky, ACP/others = assigned from a palette. Never logos.
- **Typography:** Inter (UI), JetBrains Mono (code/terminal); both OFL, bundled. Scale: 12 / 13 (default UI) / 14 (chat body) / 16 / 20 / 28. Chat text size adjustable.
- **Shape:** 4 pt spacing grid; radii 8 (controls), 12 (cards), 16 (panels); 1px borders; shadows only on lifted/selected elements.
- **Motion:** 120 ms (hover/press), 200 ms (open/close), 320 ms (layout shifts); `cubic-bezier(0.2, 0.8, 0.2, 1)`. All motion respects `prefers-reduced-motion` and a Settings toggle.
- **Background:** subtle dotted grid on canvas (Dots / Lines / None); optional user wallpaper (image, video or GLSL shader) with parallax; card opacity slider for "see-through" mode.

### 8.2 App layout

```
┌─[● ● ●]  Lattiz   [Canvas ▾][Website ×][Focus: Launch ×][+]        [⌘K Search]  [⚙]─┐
├──────────────┬─────────────────────────────────────────────────────────┬─────────────┤
│ Projects│Files│                                                         │  DOCK       │
│ │Inbox (3)   │                 INFINITE CANVAS                         │ [Term][Web] │
│              │   ┌Website ──────────────────────────────┐              │ [Files][Diff]│
│ ▸ Home       │   │ ┌Chat·Claude┐ ┌Chat·Codex┐ ┌Card┐    │              │             │
│ ▾ Website ●2 │   │ └───────────┘ └──────────┘ └────┘    │              │             │
│   Main canvas│   └──────────────────────────────────────┘   [minimap]  │             │
│ ▸ Side proj  │                                                         │             │
├──────────────┴─────────────────────────────────────────────────────────┴─────────────┤
│ ● 3 working  ● 1 needs you │ Claude ▓▓▓▓░ 62% · resets 18:00 │ Codex ▓▓░░░ 31% │ v0.1 │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- **Title bar:** custom, draggable; tabs for canvases and saved focus views; drag a tab right to split view; right-click → Open in new window.
- **Left sidebar** (resizable, collapsible `Ctrl+B`): tabs **Projects** (tree with live status counts), **Files** (project tree with git status markers), **Inbox** (attention queue).
- **Right dock** (resizable, collapsible `Ctrl+\``): **Terminal** (per project), **Browser** (localhost preview), **Files** (viewer), **Diff** (current selection).
- **Status bar:** agent counts by state (click to filter/jump), usage meters per provider, update notice, background tasks.

### 8.3 Canvas

- **Navigation:** trackpad two-finger pan; `Space`+drag or middle-drag pan; `Ctrl/⌘`+scroll or pinch zoom (10%–400%); `Shift+1` fit all; `Shift+2` fit selection; `0` = 100%.
- **Selection:** click, `Shift`-click, marquee; group move; align/distribute from a floating toolbar; `Ctrl`+drag snaps to neighbours; smart guides.
- **Project frames:** every project is a frame (labelled, coloured group). Dragging the label moves everything inside. Frame toolbar on hover: New chat, Terminal, Open folder, Fit, Colour, Rename.
- **Placement:** new nodes appear in the nearest free spot next to their creator (or inside the active project frame), animate in, and if off-screen trigger a toast with "Show".
- **Context menu (right-click canvas):** New chat (agent submenu), New note, New card, New flow, New project, Paste, Tidy up.
- **Minimap** bottom-right with zoom % (click → 100%), collapsible.
- **Virtualisation:** only nodes intersecting the viewport (+20% margin) mount full React trees; others render as lightweight placeholders. Chats on non-visible canvases keep running in main; their UI unmounts.

### 8.4 Semantic zoom (differentiator)

| Zoom | Chat node renders as |
|---|---|
| ≥ 70% | Full chat card (transcript, composer) |
| 45–70% | Condensed: header + last assistant message (3 lines) + current step row + composer collapsed |
| < 45% | **Status tile:** agent hue bar, title, big state indicator, current action ("Editing src/api/pro.ts"), elapsed time, pending-approval badge. Click to zoom-to-fit that chat. |

Cards and terminals follow the same pattern (title + thumbnail at low zoom).

### 8.5 Chat card anatomy

```
┌▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔┐  ← 2px agent-hue top border
│ ● Pricing page   [Claude Code · opus ▾]  ⎇ wt/pricing  ⋯ │  ← header
├────────────────────────────────────────────────────────┤
│ You: Swap the hero screenshot for the new demo          │
│ ▸ Read app/page.tsx                                     │  ← collapsed step rows
│ ▸ Edited app/page.tsx  +12 −3                [diff]     │
│ Assistant: Done. The hero now plays the new demo…       │
│ ┌ Permission ─────────────────────────────────────────┐ │
│ │ Run `npm install sharp`?  (reason: image resizing)  │ │  ← inline request
│ │ [Allow once] [Always for this chat] [Deny ▾]        │ │
│ └─────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────┤
│ Worked 42s · 3.1k tokens · ↶ undo turn · ⧉ copy         │  ← turn footer
├────────────────────────────────────────────────────────┤
│ [Ask Claude…  @file  /skill  📎]   ask ▾  ⏵ / ■         │  ← composer
└────────────────────────────────────────────────────────┘
```

- **Header:** status dot (state colours), editable title (auto-titled from first exchange until edited), agent+model picker (switching agent = handoff, §9.11), cwd/branch chip (click → folder menu: open in editor, reveal, change folder, work in own copy, review changes), `⋯` menu (open as terminal, rename, duplicate, export transcript, delete).
- **Body:** virtualised transcript; markdown with Shiki code blocks (copy button); step rows collapsed by default with icon per `ToolKind`, expandable to IN/OUT; inline diffs for edits; subagent steps open to prompt/steps/report; thinking collapsed under "Thought for 6s".
- **Interactive blocks:** permissions (Allow once / Always for this chat / Always for this project / Deny with optional reason), questions (option buttons + free text), plans (rendered markdown with Approve / Keep planning).
- **Composer:** multiline; `Enter` send, `Shift+Enter` newline; `@` file picker (fuzzy, project-scoped); `/` skills & commands; paste/drop images and files; quick toggles for model, reasoning level and permission mode; while working, Send becomes **Queue** (steer, §9.9) and ■ Stop is shown; right-click Send → **Send later** (§9.10); ghost-text suggestion of likely next prompt (`Tab` to accept; optional).
- **Selection actions:** select text in a reply → "Reply quoting this" / "Send to another chat".

### 8.6 Attention system

- Any `permission.requested`, `question.asked`, `plan.proposed`, `turn.completed`, `error` or `rate_limited` event creates an **attention item**.
- **Inbox tab** lists them newest first, grouped by project, with inline actions (approve/deny/answer) so the user can clear approvals without visiting each chat.
- `Ctrl+J` jumps (pans + zooms) to the next item; `Ctrl+Shift+J` previous.
- **OS notifications** for needs-you and finished (configurable per type; suppressed when the window is focused and the chat is visible). Clicking a notification focuses the chat. Permission notifications offer Allow/Deny actions where the OS supports it.
- Dock/taskbar badge = count of needs-you items. Optional soft sound.
- Status bar and sidebar counts mirror the inbox.

### 8.7 Focus mode

Select nodes → `F` (or toolbar Focus) → they fill the screen in a layout: **Grid**, **Stage** (one large + others live in a side rail), **Columns** (full-height scrollable columns). Saved as a tab; reopen restores layout. `Esc` exits. Distraction-free toggle (`Ctrl+Shift+F`) hides sidebar, tabs and status bar.

### 8.8 Command palette (`Ctrl/⌘+K`)

Fuzzy search across: actions, projects, chats (by title and content), cards, notes, files in the active project, settings, and **deleted items** ("Restore …"). Actions include: New chat with <agent>, Switch account, Open in editor, Toggle theme, Show me around, Tidy canvas.

### 8.9 Review Inbox & diff viewer (see §9.5)

A dedicated panel (`Ctrl+Shift+R`), opening in the dock or full-screen.

### 8.10 Onboarding (first run, < 2 minutes)

1. **Welcome** (one screen, skippable).
2. **Agent detection:** cards for each built-in agent showing Installed / Not installed (with copyable install command) / Signed in / Signed out. "Sign in" opens the agent's own login in an embedded terminal. Must proceed with ≥1 ready agent (or the FakeAdapter "Demo agent" for exploring).
3. **First project:** pick a folder (or "Create a sandbox project").
4. **First run:** two chats appear side by side in the project frame with a suggested starter prompt each; a 5-step interactive checklist (send a message, approve a permission, open the diff, zoom out to see the status tiles, open the palette).

### 8.11 Settings

Sections: **General** (startup, updates, keep awake while agents work, data folder, telemetry opt-ins), **Agents** (detected agents, accounts, default models, manifests), **Permissions** (default mode for new chats = `auto-edit`, always-ask command list, per-project overrides), **Appearance** (theme, accent, density, interface size, chat text size, card style Glass/Solid, grid, wallpaper, motion), **Notifications**, **Connections (MCP)**, **Skills**, **Shortcuts** (rebindable), **Data** (export, clear, open folder).

### 8.12 Accessibility

- Every action keyboard-reachable; visible focus rings (accent, 2px).
- WCAG AA contrast for text in both themes.
- State is never conveyed by colour alone (dot shape/icon + label + `aria-live` announcements for needs-you).
- Respects reduced motion; screen-reader labels on all icon buttons.

### 8.13 Empty, loading and error states

Every surface has a designed empty state with one primary action (e.g. empty canvas: "Open a folder to start a project" + "Try the demo"). Loading uses skeletons, not spinners, beyond 300 ms. Errors explain what happened and offer one fix action (e.g. "Codex isn't signed in → Sign in").

---

## 9. Feature specifications & acceptance criteria

Each feature lists acceptance criteria (AC). A feature is done when all AC pass and are covered by tests where feasible.

### 9.1 Projects & folders
- AC1 Create a project from any folder; it appears as a frame with a terminal available in the dock at that cwd.
- AC2 Sidebar shows per-project counts: working / needs-you / finished-unseen.
- AC3 Deleting a project removes it from the canvas (soft delete) but **never touches files on disk**.
- AC4 A project folder that disappears shows a "Folder missing → Locate" state.

### 9.2 Chats
- AC1 New chat with any ready agent, model and reasoning level, in a chosen cwd.
- AC2 Streaming text renders progressively at ≥ 30 fps without layout jank.
- AC3 Tool steps show as collapsible rows; file paths are clickable (open in file viewer).
- AC4 Chats persist and resume after app restart (via `native_session_id` where supported; otherwise the transcript is shown read-only with "Start new conversation with summary").
- AC5 Open as terminal: toggles the card body to the agent's native TUI on the same cwd and conversation (if `resume` supported); toggle back.

### 9.3 Parallel isolation (worktrees)
- AC1 When a second chat targets a git repo that already has an active chat, Lattiz offers (default on) "Work in its own copy" → creates `git worktree` on branch `lattiz/<chat-slug>` from current HEAD.
- AC2 Branch/worktree chip visible on the chat header.
- AC3 "Review changes…" opens the diff of the worktree branch vs. its base.
- AC4 **Merge** brings changes into the base branch (merge or squash, user's choice). Before merging, run a dry-run merge; if conflicts exist, show the conflicting files and offer: open in editor, ask the agent to rebase/resolve, or cancel.
- AC5 After merge, offer to remove the worktree; removal never deletes unmerged commits without explicit confirmation.
- AC6 Non-git folders: isolation unavailable, with a one-click "Initialise git here" option.

### 9.4 Checkpoints, undo & timeline
- AC1 Before each turn that may edit files, create a lightweight checkpoint (e.g. a stash-like commit object on a hidden ref `refs/lattiz/checkpoints/<chat>/<turn>`), without touching the user's index or branch.
- AC2 ↶ **Undo turn** restores every file the turn changed; ↷ redoes. The agent is told in the next message that files were reverted.
- AC3 Timeline view (chat `⋯` → Timeline) lists turns with files changed and lets the user restore to any checkpoint.
- AC4 Works in worktrees and in the main folder. Requires git; degrades with a clear message otherwise.

### 9.5 Review Inbox (differentiator)
- AC1 Every completed turn that changed files creates a review item: chat, agent, summary (agent's final message, first 2 lines), files changed with +/− counts.
- AC2 Diff viewer: unified/split toggle, syntax highlighted, file tree, per-hunk **Accept** / **Revert**, per-file Accept/Revert, "Accept all".
- AC3 Reverting hunks writes the files and notifies the agent on its next turn.
- AC4 "Ask for changes": type feedback on a hunk or file → sent to the originating chat as a message quoting the hunk.
- AC5 Items can be filtered by project/agent and marked reviewed; count shown in sidebar.

### 9.6 Terminal dock
- AC1 One persistent terminal per project (more via `+`), at the project cwd, using the user's default shell with login env.
- AC2 Full xterm features: WebGL rendering, search, clickable links/paths, copy-on-select option, paste images as files for agent CLIs.
- AC3 Terminals survive canvas switches; closing the app warns if processes are running.

### 9.7 Browser preview + element picker
- AC1 Dock browser (`Ctrl+Shift+B`) loads any URL; defaults to detected dev server ports in the project (scan 3000–3010, 4173, 5173, 8000, 8080).
- AC2 Device presets (phone/tablet sizes, portrait/landscape) with touch emulation.
- AC3 **Pick element:** click any element → choose target chat → chat composer gets the element's outer HTML (trimmed), CSS selector, computed key styles, and a screenshot of the element as an image attachment.
- AC4 Clear error page when nothing is listening ("Nothing running on :3000. Start your dev server in the terminal?").

### 9.8 Permissions & guardrails
- AC1 Modes per chat: **Read-only**, **Ask** (ask before edits and commands), **Auto-edit** (edits allowed, commands ask; default), **Full-auto**.
- AC2 Mapped to each agent's native permission system where available (e.g. Claude Code permission modes/hooks, Codex approval & sandbox policies); documented per adapter where emulated or unsupported.
- AC3 **Always-ask list** (Settings → Permissions), e.g. `git push`, `rm -rf`, `npm publish`: these always require approval even in Full-auto, wherever the agent exposes a pre-execution hook. Where enforcement is impossible for an agent, its chat header shows a warning icon explaining so.
- AC4 "Always allow" decisions are scoped (chat or project) and listed/revocable in Settings.

### 9.9 Steering & queue
- AC1 While a turn runs, composer submit queues the message; it appears pinned above the composer as "Next step".
- AC2 If the adapter supports `steer`, deliver at the next step without interrupting; otherwise deliver immediately after the turn ends.
- AC3 Queued messages can be edited, deleted, or "Send now" (interrupt + send).

### 9.10 Send later & limit handling
- AC1 Right-click Send → in 30 min / 1 h / 3 h / tomorrow 09:00 / custom / **when limit resets**. Optional repeat (every N minutes/hours/daily).
- AC2 Scheduled messages show above the composer with countdown; survive restarts; fire on next launch if missed (once, with a note).
- AC3 On `rate_limited`, the chat shows a banner: **Send when it resets** / **Continue with <other connected agent>** (§9.11) / Dismiss.

### 9.11 Handoff ("Continue with…")
- AC1 From the model picker or the rate-limit banner, choose another agent.
- AC2 Lattiz builds a handoff brief: original goal, a summary of what was done (generated by the outgoing agent if available, else by a short summarisation call on the incoming agent), current `git diff --stat` + list of changed files, and open TODOs. The user can edit the brief before sending.
- AC3 New chat opens beside the old one, same cwd/worktree, linked visually ("continued from").

### 9.12 Usage meter
- AC1 Status bar shows per provider/account: usage % of the current window and reset time, where the adapter can obtain it (`usage()` or rate-limit events). Unknown is shown as "—", never guessed.
- AC2 Per turn: duration and output tokens; cost only when the provider reports it, labelled "API-equivalent" if it doesn't reflect the user's plan billing.
- AC3 Multiple accounts per provider: add, label, switch (switch waits for running turns to finish).

### 9.13 Notes
- Markdown notes on the canvas with live preview (headings, lists, tasks, code, tables, links). Can be flow outputs (§11). Stored in the DB (exportable as `.md`).

### 9.14 Skills (prompt snippets)
- Reusable instructions stored as markdown (`skills/*.md`), attached via `/skill-name` in the composer; also importable `SKILL.md` folders. Project-level skills live in `<project>/.lattiz/skills/`.

### 9.15 MCP connections
- AC1 Add MCP servers (stdio command or HTTP URL, with headers/keys; OAuth sign-in where the server supports it).
- AC2 Import existing configs found in other apps' MCP config files *only after the user clicks Import*, showing exactly what will be copied.
- AC3 Per-server toggle "Share with every chat"; passed to agents that support MCP via their native config/flags.
- AC4 Secrets stored via safeStorage, never in plain JSON.

### 9.16 Search & restore
- `Ctrl+K` covers everything in §8.8. Full-text search over chat events (SQLite FTS5).

---

## 10. Conductor & the Workspace MCP server (differentiator)

### 10.1 Workspace MCP server

Lattiz runs an MCP server that exposes the workspace itself as tools. It's offered over:
- **Streamable HTTP** bound to `127.0.0.1` on a random port with a per-launch bearer token, and
- a tiny **stdio shim binary** `lattiz-mcp` (bundled) that forwards to the running app, for agents that only support stdio.

**Tools:**

| Tool | Purpose |
|---|---|
| `list_projects()` | Projects with folder, active chats count |
| `list_chats(project_id?, status?)` | id, title, agent, model, cwd, branch, status, last activity |
| `read_chat(chat_id, last_turns=3)` | Recent user/assistant messages + step summaries |
| `spawn_chat(agent, cwd, prompt, model?, own_copy?, title?)` | Start a chat, returns id. Placed on canvas next to the caller |
| `send_message(chat_id, text, mode="queue"\|"now")` | Message another chat |
| `wait_for_chats(chat_ids, timeout_s=900)` | Block until all are idle/finished; returns final messages |
| `get_diff(chat_id)` | Diff stat + patch (truncated with a size cap) |
| `create_note(title, markdown, near_chat_id?)`, `append_note(...)` | Write results to the canvas |
| `create_card(title, html)` / `update_card(card_id, html)` | Build mini-apps (§12) |
| `focus(node_ids, layout?)` | Open a focus view for the user |
| `create_flow(spec)` | Build a flow from a JSON spec (§11) |

**Guardrails:** spawned chats inherit the caller's permission mode or stricter; max concurrent chats spawned per caller (default 6, configurable); a chat may only close/delete chats it spawned, and only after user confirmation; every tool call is logged in the caller's transcript and visible to the user.

### 10.2 Conductor

- A pinned, undeletable chat (default position top-left of the main canvas) running on a user-chosen agent (default: first ready of Claude Code → Codex → Gemini).
- Uses the Workspace MCP server plus a built-in system prompt (`resources/conductor/SYSTEM.md`) that explains Lattiz concepts and tool usage, and a user-editable `AGENTS.md` for personal preferences.
- **Any** regular chat can be given the Workspace MCP tools via its `⋯` menu ("Give workspace tools"), so a Claude Code chat can itself orchestrate Codex chats.
- Must handle requests like:
  - "Spawn two Claude and two Codex chats in ~/code/shop and have each find the slowest page; then compare."
  - "Which chats are done? Summarise what each changed."
  - "I want to work on the website" → opens related chats/cards in focus mode.
  - "Tidy my canvas" → arranges nodes into their project frames in rows.

---

## 11. Flows engine

A **flow** is a frame containing chats, notes and cards connected by directed edges. When a node produces output, the output travels along its outgoing edges.

### 11.1 Node types inside a flow
- **Start**: entry point; user input or schedule payload. Option "one task per line" (each line becomes a separate item).
- **Chat**: an ordinary chat with an optional **job** (role instructions appended to every message it receives).
- **Note**: appends each arriving item under a header (sender, time).
- **Card**: receives items into its data; interactive gate cards (§11.4) can send items onward.

### 11.2 Edge modes
- **every** (default): each output goes to the target.
- **free**: among sibling edges with mode `free` from the same source, each item goes to the first idle target (work-sharing team).
- **wait_all**: the target waits until every `wait_all` edge into it has delivered one item, then receives them together, each labelled with its sender (join).
- **approval**: item waits for the user to **Keep**, **Send back with feedback** (re-runs the source with the feedback) or **Drop**.

### 11.3 Run semantics
- **Brief:** flow-level goal/constraints, prepended to every message any chat in the flow receives.
- **Run state** persisted in `flow_runs` (items in flight, waiting gates); flows resume after restart.
- **Loop guard:** stop after N consecutive handoffs (default 10) and ask Continue / Stop.
- **Done marker:** in loops, the lead chat can end its answer with `[flow done]` to finish the run.
- Controls: ▶ Start, ⏸ Pause (holds handoffs), ■ Stop (interrupts all, drops waiting items), ☰ Run log (what started it, each handoff, user decisions).
- **Schedule:** hourly/daily/weekly at a time (cron under the hood); runs while the app is open; if missed, runs once on next launch.

### 11.4 Built-in gate cards
**Pick one** (options side by side, only the pick proceeds), **Review** (edit text, then send), **Shortlist** (checkboxes), **Form** (fields defined by the flow), **Results** (collector list).

### 11.5 Templates (one click, then editable)
- **Council:** 4 chats with roles *builder / skeptic / simplifier / user-advocate*, each on a different connected agent where possible → `wait_all` → synthesiser chat → "Decision" note (agreement, disagreement, what nobody checked, recommendation).
- **Review ×3:** same input to 3 reviewers (correctness / simplicity / readability) → note.
- **Pipeline:** research → write → edit → note.
- **Team:** Start (one task per line) → `free` edges → 3 workers → Results card.
- **Daily digest:** schedule 08:00 → 2 watchers → writer → approval → note.

### 11.6 Building flows conversationally
The conductor's `create_flow(spec)` accepts:

```json
{
  "name": "Blog pipeline",
  "brief": "For parents, plain words, under 300 words.",
  "nodes": [
    { "id": "start", "type": "start", "oneTaskPerLine": false },
    { "id": "research", "type": "chat", "agent": "claude-code", "job": "Find 3 credible facts." },
    { "id": "write", "type": "chat", "agent": "codex", "job": "Write the post." },
    { "id": "out", "type": "note", "title": "Result" }
  ],
  "edges": [
    { "from": "start", "to": "research" },
    { "from": "research", "to": "write" },
    { "from": "write", "to": "out", "mode": "approval" }
  ],
  "schedule": null
}
```

The engine validates the spec (zod), lays it out left-to-right by topological order ("Tidy up"), and renders it.

---

## 12. Cards (live mini-apps)

A card is a small HTML app on the canvas, written by an agent on request ("make me an invoice tracker").

### 12.1 Isolation (non-negotiable)
- Each card is served from a custom protocol `card://<card-id>/index.html` (its own origin) inside an `<iframe sandbox="allow-scripts allow-forms">`.
- Default CSP: `default-src 'self' card:; connect-src 'none'; img-src 'self' data: card:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`. **No network by default.**
- Optional per-card network allowlist (exact origins), granted only by the user via a prompt that names the domains.
- A card can never read the user's files, keys, other cards' data or chats.

### 12.2 Card bridge API (via `postMessage`, wrapped as `window.lattiz` inside the card)
- `data.get(key)`, `data.set(key, value)`, `data.list()`: persisted in `card_data`.
- `refresh()`: runs the card's optional **refresh script** (written by the agent, stored in the card folder, shown to and approved by the user on first run) in a separate Node child process with cwd = card folder, no inherited env secrets, timeout 60 s; its JSON stdout is written into card data.
- `ask(prompt)`: pre-fills the conductor's composer (user must press send).
- `sendToFlow(payload)`: only for cards that are flow gates.
- `exportPdf()`: renders the card to an A4 PDF via a save dialog.
- `theme`: current tokens (colours, fonts), with a change event, so cards can match light/dark/accent.

### 12.3 Storage & lifecycle
- `cards/<id>/index.html` (+ optional `refresh.mjs`, assets).
- Cards on non-visible canvases are unloaded after 30 s and restored on return.
- Starter library (bundled, offline): Habit tracker, Countdown, Kanban, Repo dashboard (uses refresh script + `gh` CLI), Usage dashboard (reads Lattiz's own usage data through the bridge), Pomodoro.

---

## 13. Security & privacy

- Renderer hardening per §5.1; `webContents` navigation and `window.open` blocked except via an allowlisted handler; external links only for `http(s)` and `mailto`, opened in the system browser; any other scheme requires confirmation.
- Secrets (API keys, MCP tokens) via Electron `safeStorage`; never logged; scrubbed from crash reports and exported backups.
- Workspace MCP server: loopback only, random port, bearer token rotated each launch.
- **No telemetry by default.** Opt-in anonymous crash reports (paths, usernames and keys scrubbed) and opt-in usage analytics, both off on install, both clearly described.
- Auto-updates over HTTPS from GitHub Releases with signature verification; macOS notarized, Windows Authenticode-signed (M7).
- On startup, verify app bundle integrity where the platform allows; refuse to run modified builds of the auto-updater.
- Document everything that leaves the machine in `docs/privacy.md`, mirrored in Settings → Data.

---

## 14. Performance budgets

Measured on a 2021 M1 MacBook Air and a mid-range Windows laptop (16 GB RAM):

| Metric | Budget |
|---|---|
| Cold start → interactive canvas | < 2.5 s |
| Pan/zoom with 50 nodes, 10 streaming chats | 60 fps (no frame > 32 ms in a 10 s trace) |
| Agent event → pixels | < 50 ms p95 |
| Idle CPU, 10 idle chats | < 2% |
| Memory | < 600 MB base, < 50 MB per active chat UI |
| Open a 2,000-turn transcript | < 300 ms to first paint (virtualised) |
| Diff of a 5,000-line file | < 200 ms (worker) |

Techniques: rAF-batched store updates, node virtualisation (§8.3), transcript virtualisation, memoised node renderers, workers for highlighting/diffs, unloading off-canvas cards, `will-change` only during gestures. Add a hidden **Perf overlay** (`Ctrl+Alt+P`) showing fps, event rate and memory.

---

## 15. Repository structure

```
lattiz/
├─ apps/desktop/
│  ├─ src/main/            # AppCore services (§5)
│  │  ├─ agents/           # registry, supervisor, adapters/{claude-code,codex,acp,terminal,fake}
│  │  ├─ git/  pty/  store/  mcp/  flows/  cards/  scheduler/  usage/  attention/
│  │  └─ index.ts
│  ├─ src/preload/index.ts # window.lattiz from ipc-contract
│  └─ src/renderer/
│     ├─ app/              # layout, routing between canvas/focus
│     ├─ canvas/           # React Flow setup, node types, semantic zoom
│     ├─ chat/             # chat card, transcript, composer, interactive blocks
│     ├─ inbox/  review/  dock/  palette/  settings/  onboarding/
│     └─ stores/
├─ packages/
│  ├─ shared/              # ipc-contract.ts, AgentEvent schema, types
│  ├─ ui/                  # tokens.css, primitives (Button, Chip, Menu, Dialog…)
│  └─ lattiz-mcp-shim/     # stdio → app forwarder
├─ resources/conductor/SYSTEM.md
├─ fixtures/               # recorded adapter streams, fake scripts, temp-repo seeds
├─ docs/                   # adapters/*.md, privacy.md, architecture.md
├─ e2e/                    # Playwright tests
├─ docs/dev/SPEC.md  PROGRESS.md  DECISIONS.md
└─ package.json (pnpm workspaces)
```

---

## 16. Testing strategy

- **Unit (Vitest):** adapter event mapping (replaying **recorded real streams** from `fixtures/<agent>/*.jsonl`; record them when verifying each adapter), flow engine (all edge modes, loop guard, resume), git service against temp repos (worktrees, checkpoints, undo, conflict detection), scheduler, IPC schema validation.
- **Integration:** SessionSupervisor with FakeAdapter, including crash/restart and permission round-trips.
- **E2E (Playwright + Electron):** scenarios S1–S6 using the FakeAdapter; onboarding; command palette; semantic zoom thresholds; undo turn; review inbox accept/revert.
- **Visual:** screenshot tests for chat card states (idle, working, needs-you, done, error) in both themes.
- **Perf:** scripted benchmark that spawns 30 FakeAdapter chats streaming and asserts §14 budgets in CI (Linux) with tolerance.
- **Manual QA checklist** per milestone in `docs/qa/Mx.md`, including each real adapter on Windows and macOS.

---

## 17. Milestones

Each milestone ends with: all tests green, `PROGRESS.md` updated, app packaged locally for the dev's OS.

### M0: Foundation
- electron-vite monorepo (pnpm), strict TS, lint/format, CI.
- Design tokens + UI primitives; app shell (title bar, sidebar, canvas, dock, status bar) with light/dark.
- React Flow canvas: pan/zoom/select, minimap, persisted viewport.
- SQLite + drizzle migrations; IPC contract with zod; preload API.
- FakeAdapter + a fake chat node rendering a scripted stream.
- **Exit:** app launches on all 3 OSes in CI builds; a fake chat streams on the canvas; state persists across restart.

### M1: First real agent, end to end
- Verify and implement the **Claude Code** adapter (§6.3), write `docs/adapters/claude-code.md` with recorded fixtures.
- Chat card (§8.5) complete: streaming, steps, inline diffs, permissions, questions, plans, stop.
- Projects from folders; per-chat cwd; model/reasoning/permission pickers.
- **Exit:** user can open a repo, chat with Claude Code, approve a command, see edits as diffs, restart the app and resume the conversation.

### M2: Many agents
- **Codex**, **Gemini (ACP)**, **generic ACP manifests**, **terminal-only** adapters (each verified + documented).
- Terminal dock (node-pty + xterm); open-as-terminal per chat.
- Attention system (§8.6) incl. OS notifications and `Ctrl+J`; sidebar status counts; status bar.
- Onboarding agent detection & sign-in flows.
- **Exit:** scenario S2 and S3 pass with real agents; 6 chats across 3 agents run concurrently within perf budgets.

### M3: Safe changes
- Worktrees (§9.3), checkpoints/undo/timeline (§9.4), diff viewer, **Review Inbox** (§9.5), merge with conflict detection.
- **Exit:** scenario S1 passes end to end.

### M4: The great UI
- Semantic zoom (§8.4), focus mode (§8.7), command palette + FTS search + restore (§8.8, §9.16), project frames polish, smart placement, notes, browser dock + element picker (§9.7), appearance settings & wallpapers, accessibility pass, onboarding checklist.
- **Exit:** design review against §8: every state designed; keyboard-only walkthrough of S1 succeeds.

### M5: Orchestration
- Workspace MCP server + stdio shim (§10.1), Conductor (§10.2), "Give workspace tools" on any chat, MCP connections (§9.15), skills (§9.14).
- **Exit:** scenario S4 passes with a real agent as conductor.

### M6: Power features
- Flows engine + templates + gate cards (§11), cards + bridge + starter library (§12), send later & limit handling (§9.10), handoff (§9.11), usage meter & multiple accounts (§9.12).
- **Exit:** scenarios S5 and S6 pass.

### M7: Ship
- Packaging, code signing, notarization, auto-update channel (stable/beta), perf pass to §14, security review against §13, privacy doc, user docs site skeleton, crash-report opt-in.
- **Stretch:** OpenAI-compatible Native agent (§6.3); local voice typing (whisper.cpp, on-device); **Remote**: a LAN-only web UI served by the app, paired via QR code + one-time token, to follow chats and answer approvals from a phone.
- **Exit:** signed installers for Windows/macOS/Linux; clean install → first agent reply in < 2 minutes for a new user.

---

## 18. Open questions (decide and log in DECISIONS.md)

1. **Identity:** Lattiz logo and app icon design; check domain and trademark availability.
2. **License:** MIT/Apache-2.0 (encourages community adapters and manifests) vs. source-available.
3. **Business model:** free + Pro (unlimited parallel agents, flows, remote) vs. fully free/open.
4. **Primary QA platform** for early releases (Windows-first vs. macOS-first).
5. **Worktree location default:** inside the data dir vs. sibling folder next to the repo (affects tooling that expects repo-relative paths).
6. **Subscription-login compliance** outcome per provider (§6.5) and its effect on onboarding.
