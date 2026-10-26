# Decisions

One entry per choice the spec left open. Newest last.

### 2026-10-22 — Primary platform: macOS (§18 Q4)

Context: dev machine is an M-series Mac. Decision: macOS-first for QA; Windows/Linux covered by CI builds. Why: only platform we can test by hand right now.

### 2026-10-22 — Worktree default location: data dir (§18 Q5)

Decision: keep the spec's default (`<dataDir>/worktrees`). Revisit in M3 if tooling needs repo-relative paths.

### 2026-10-22 — License: deferred (§18 Q2)

Not needed until the repo goes public.

### 2026-10-22 — TypeScript 6.0, not 7.0

Context: TS 7.0.2 is current, but typescript-eslint 8.72 supports `<6.1`. Decision: pin `~6.0.3`. Revisit when typescript-eslint supports 7.

### 2026-10-22 — pnpm 10 via corepack

pnpm 12 ships a native binary that the installed corepack can't launch. Pinned `packageManager: pnpm@10.34.7`.

### 2026-10-22 — Migrations bundled, applied via `PRAGMA user_version`

drizzle-kit generates SQL; the main bundle embeds it (`import.meta.glob`) and a ~15-line migrator applies it. Why: packaged builds need no migrations folder on disk, and drizzle's runtime migrator reads files.

### 2026-10-22 — SQLite tests run under Electron-as-Node

better-sqlite3 is compiled for Electron's ABI, so Node can't load it. `scripts/test-native.mjs` runs the `native` Vitest project with `ELECTRON_RUN_AS_NODE=1`. Avoids rebuilding the module back and forth.

### 2026-10-22 — `AgentSession.onExit` added to the §6.1 interface

The supervisor needs a crash signal distinct from events to move a chat to `error`. Every process-backed adapter can provide it.

### 2026-10-22 — FakeAdapter runs in a real child process

Rather than replaying in-process, the fake spawns `fake-runner.js` (Electron-as-Node) and talks JSON lines over stdio, like real agent CLIs. Why: exercises the supervisor's crash/restart path and the stdio plumbing M1–M2 adapters will reuse.

### 2026-10-22 — User messages live in `turns`, not the event log

The §6.2 union has no user-message event. Transcripts are projected from `turns` + `events` (`buildTranscript`). Keeps the event log purely agent-sourced.

### 2026-10-22 — Chats mid-turn at shutdown restart as `idle`

Their processes are gone; resume semantics come with real adapters in M1 (§9.2 AC4).

### 2026-10-22 — Only externalised runtime deps ship

`apps/desktop` `dependencies` = `better-sqlite3`, `drizzle-orm` (externalised by electron-vite). Everything else is a devDependency and bundled. Keeps app.asar ~12 MB.

### 2026-10-22: Drive the user's installed `claude`, don't ship the SDK's bundled CLI

The Agent SDK bundles a ~263 MB CLI binary per platform. Latis passes `pathToClaudeCodeExecutable` = the user's `claude` (resolved through the login shell's PATH) and excludes the bundled binaries from the app. Why: SPEC §6.5 prefers the user's own CLI under its own auth, and the app stays small. Cost: users must install Claude Code; onboarding shows the install command.

### 2026-10-22: Permission-mode mapping for Claude Code

Read-only → `default` + Latis denies non-read tools in `canUseTool`; Ask → `default`; Auto-edit → `acceptEdits`; Full-auto → `bypassPermissions`. `allowDangerouslySkipPermissions` is always set so a chat can switch into Full-auto live; the starting mode is unaffected.

### 2026-10-22: "Always allow" stays session-scoped

Claude's permission suggestions target `localSettings`, which writes into the repo's `.claude/settings.local.json`. Latis rewrites them to `destination: "session"` so it never edits the user's repo config. "Always for this project" behaves the same until Latis stores project rules itself.

### 2026-10-22: AgentEvent extensions

`file.changed` gains optional `hunks`/`additions`/`deletions` (inline diffs), and `question.asked` gains optional structured `questions[]` (Claude asks up to 4 multiple-choice questions at once). Both optional, so other adapters are unaffected.

### 2026-10-22: Dialog tools aren't shown as steps

`AskUserQuestion` and `ExitPlanMode` appear only as question/plan blocks, not also as tool step rows.

### 2026-10-22: Real agents require a project; the demo agent doesn't

Real agents always run in a project folder (a frame on the canvas). The demo agent runs in a throwaway sandbox folder so it can never write into a real repo.

### 2026-10-22: Auto-title = first line of the first message (≤ 48 chars)

Simplest version of §8.5's "auto-titled from first exchange". No extra model call. Renaming locks the title.

### 2026-10-22: Replay mode for e2e

`LATIS_CLAUDE_REPLAY=<dir>` swaps the SDK's `query()` for a replayer of recorded streams that still waits on the app's permission answers. CI-safe, with no tokens or network. The real CLI is covered by the opt-in live test.

### 2026-10-22: Shiki with the JavaScript regex engine

Avoids WASM, so the CSP needs no `wasm-unsafe-eval`. 15 common languages load lazily in a web worker.

## M2

### 2026-10-23: Codex permission modes, plus Latis-side auto-accepts

Read-only → `read-only` sandbox, `never`; Ask and Auto-edit → `workspace-write`, `untrusted`; Full-auto → `danger-full-access`, `never`. Recorded: `untrusted` asks before every patch and even `cat`. So Latis answers some requests itself: pure reads (Codex's own `commandActions` parse) in Ask and Auto-edit, and patches whose paths are all inside the chat folder in Auto-edit. Mode changes ride on the next `turn/start`.

### 2026-10-23: ACP modes map by name; emulation otherwise

A manifest can map Latis modes to the agent's mode ids. Otherwise Latis matches well-known ids (`plan`, `default`, `autoEdit`/`acceptEdits`, `yolo`/`bypassPermissions`). On top, `session/request_permission` is answered by mode: Full-auto allows, Read-only rejects non-read kinds, Auto-edit allows in-folder edits. Latis declares no `fs`/`terminal` client capabilities, so agents work on disk with their own tools.

### 2026-10-23: ACP model lists come from a probe session

ACP has no model list without a session, so `authStatus()` opens one `session/new` in `<dataDir>/probe` (no prompt, no tokens). That answers both "signed in?" and the picker's models. A failed `session/new` with an auth error means Signed out.

### 2026-10-23: Steering

Claude Code: a user message with `priority: "next"`. Codex: `turn/steer`. Both verified live. Agents without steering (generic ACP, the demo agent) queue the message until the turn ends cleanly (§9.9 AC2). Stopping a turn keeps the queue; "Send now" interrupts and sends. Steered messages are logged as a `user.steered` event because agents don't echo them. The queue lives in memory and is lost on quit.

### 2026-10-23: Attention items carry their own summary

The `attention` table gets a `data_json` (summary, detail) beyond the §7.1 sketch, so the Inbox can show and answer items without loading transcripts. Request items close when answered anywhere or when the agent moves on. "Finished" items close when the chat is selected or sent to again.

### 2026-10-23: Notifications and badge

Native notifications for needs-you and finished, each toggleable, skipped when Latis is focused and the chat is on screen (the renderer reports visible chats). Permission notifications get Allow/Deny actions on macOS only (Electron's `actions` are macOS-only). The dock badge counts needs-you items via `app.setBadgeCount`. No Windows overlay badge yet, and no sound yet.

### 2026-10-23: Terminal-only agents and `agent.status`

A PTY shows inside the chat card; a status detector over its output emits a new `agent.status` event (working / idle / needs-you), which drives status and Inbox items. Approvals are answered in the terminal itself. A clean exit isn't a crash; the card offers "Start again". Built-in terminal manifests: Copilot CLI, OpenCode, Grok CLI, Aider (unverified, shown only when installed).

### 2026-10-23: Open as terminal stops the structured session first

One process per conversation: the chat's live session is disposed, then `claude --resume <id>` / `codex resume <id>` opens as a dock terminal. The next message sent from the card resumes the conversation again.

### 2026-10-23: Sign-in runs the agent's own login in a dock terminal

`claude auth login`, `codex login`, `gemini` (its auth picker). When the terminal closes, Latis re-checks agents. Latis never reads credential files (§6.5).

### 2026-10-23: Onboarding starts chats with editable drafts

The first-run tour creates up to two chats (the first two ready agents) with a suggested first message in the composer, not sent. The interactive checklist is left for M4. `LATIS_SKIP_ONBOARDING=1` for tests.

### 2026-10-23: Replay for every agent

`LATIS_REPLAY=<fixtures>` replays Claude (`claude-code/`), Codex (`codex/`) and the built-in ACP agent (`acp/`). The replay pauses at each recorded client message until the app sends it. `LATIS_AGENT_PATH` (dev/test) prepends folders to the PATH used to find agent CLIs.

## M3

### 2026-10-23: Checkpoints are snapshot commits on hidden refs

Before and after every turn, Latis snapshots the repo's working tree (tracked and untracked, minus ignored) as a commit object. It builds it in a throwaway index seeded from a copy of the real one (for the stat cache), so the user's staging area, HEAD and branches are never touched. Commits live under `refs/latis/checkpoints/<chat>/<turn>/{before,after}` so `git gc` keeps them. Undo/redo restore exactly the files the turn changed with `git restore --source=… --worktree`, deleting files the turn created. "Restore to before this turn" reverts the files this chat changed from that turn on. Chats sharing a folder can see each other's edits in their snapshots; that's what worktrees are for.

### 2026-10-23: Tables beyond the §7.1 sketch

`checkpoints` holds before/after commits, the files changed and `undone_at` (the sketch had one `git_ref`). `worktrees` adds `base_commit`. A new `reviews` table holds Review Inbox items with per-file/per-hunk decisions.

### 2026-10-23: The agent hears about reverts with the next message

Undo, redo, restore and Review reverts queue a `[Note from Latis] …` line that goes in front of the user's next message to that chat (§9.4 AC2, §9.5 AC3). The transcript still shows only what the user typed.

### 2026-10-23: Worktrees

- They go under `<dataDir>/worktrees/<repo>/<slug>` on `latis/<agent>-<rand>` branches from the current HEAD (§18 Q5 default).
- The second chat in a repo gets the offer, on by default.
- Any chat can move into its own copy from its folder chip. This was needed for S1's "both in separate worktrees". Claude sessions are tied to a folder, so a moved Claude chat starts a new conversation; the supervisor says so.
- For folders that aren't repos, a toast offers "Initialise git" rather than blocking.

### 2026-10-23: Merge from the project folder, after a dry run

- Merge commits the agent's pending work on its branch, then runs `git merge-tree --write-tree` (git ≥ 2.38) as a dry run that touches nothing.
- It refuses if the project folder isn't on the base branch or has uncommitted changes.
- Then it does a `--no-ff` merge or a squash in the project folder.
- On conflicts it lists the files and offers: ask the agent to merge the base in and resolve, open the copy, or cancel.
- Removing a copy refuses unmerged commits unless the user confirms. Squash-merged work counts as merged.

### 2026-10-23: Hunk revert uses `git apply -R`

A single hunk is reverse-applied to the working tree with `--recount`. If the file moved on since, Latis says so and suggests reverting the whole file instead. "Accept" is a review decision only; nothing changes on disk.

### 2026-10-23: git via `child_process.execFile`, not execa

No extra dependency for a handful of calls. `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`. When the user has no git identity, Latis commits as `Latis <latis@localhost>`.

### 2026-10-23: ACP "always allow" is remembered by Latis; refused modes aren't fatal

Gemini refuses `autoEdit`/`yolo` and `allow_always` in folders it doesn't trust, and the tool fails. Latis keeps the agent in its default mode when a switch is refused, and enforces the chat's mode on each permission request. "Always for this chat" is a Latis-side rule (tool kind, or program name for shell commands), answered with `allow_once`. Applies to every ACP agent.

### 2026-10-23: Agents run in their own process group

`spawnTransport` uses `detached` (POSIX) and kills the whole group (Windows: `taskkill /T /F`), because CLIs like `gemini` re-launch themselves and the child outlived the wrapper.

### 2026-10-23: Windows CI builds on windows-2022

better-sqlite3 13 compiles from source on install. node-gyp 11 couldn't find Visual Studio on the newer `windows-latest` image.

## M4

### 2026-10-23: Semantic zoom thresholds and tiles

≥70% full card, 45–70% condensed, <45% status tile (§8.4). Nodes subscribe to the zoom _bucket_, so they re-render only when crossing a threshold. Tiles and condensed cards are sized in canvas units (40–56 px type) so they read at 30–40%. Frames get a big label when zoomed out. Composer drafts and attachments live in the store, so cards can unmount (zoom, virtualisation) without losing text. Off-screen nodes don't render (`onlyRenderVisibleElements`).

### 2026-10-23: Keyboard

- `-` / `=` zoom the canvas (Ctrl/⌘ ± stays the interface zoom). `N` new note, `F` focus selection, Delete removes the selection, Ctrl/⌘+Z/Shift+Z canvas undo, Ctrl/⌘+A selects all, Enter on a focused chat jumps to its composer.
- The palette lists the selected chat's own actions first (own copy, merge, review branch, timeline, stop, write to).
- In the Review panel: ↑/↓, A accept all, M mark reviewed.
- Dialogs focus their primary action, and new chats focus their composer.
- Together these make S1 doable keyboard-only (`e2e/m3.spec.ts`).

### 2026-10-23: Soft delete and canvas undo

Deleting sets `nodes.deleted_at` (a frame takes its contents and archives its project) and never touches files. Items stay restorable from ⌘K for 7 days. The `deleted_items` table in the sketch wasn't needed. The undo stack is in renderer memory (50 steps; moves, resizes, deletes, new notes, tidy-ups). It isn't persisted.

### 2026-10-23: Search

An FTS5 table `search(kind, ref, chat_id, body)` indexes user messages, agent replies (`message.completed`) and note text. It's written alongside the source rows and backfilled by migration 0004. Each query word is a quoted prefix term, so FTS syntax in input can't break the query. Deleted items are filtered at query time.

### 2026-10-23: Dock browser is a native view

A `WebContentsView` in its own `persist:latis-preview` session (sandboxed, no preload, permissions denied, new windows go to the system browser) is positioned over the dock area by the renderer. Native views draw above the DOM, so it hides while any dialog is open, and an error page is drawn by the renderer instead. Device presets use the DevTools protocol (metrics, touch, mobile UA). The picker runs in an isolated world and captures the element with `capturePage`. In device presets the screenshot's crop can be off, because the page is scaled into the dock.

### 2026-10-23: Image attachments aren't stored in the transcript

Pasted or picked images go to the agent with the message, but turns store text only, so a reloaded transcript doesn't show them. Queued messages keep their images until sent.

### 2026-10-23: Appearance and contrast

- Accent, interface size (window zoom factor), chat text size, density, solid/glass cards with opacity, canvas grid, wallpaper (a data URL in settings, ≤ 8 MB) and reduce motion (plus the system setting).
- To meet WCAG AA (§8.12), `--text-3` is `#808894` (dark) and `#666e78` (light).
- The light theme's accent and state colours are darker than §8.1's table, all ≥ 4.5:1 on every surface. Accent `#0b7a6e`; working, needs-you, done and error `#875b00`, `#c03a26`, `#167a4c`, `#b8284f`.

### 2026-10-23: LATIS_DEMO_IN_PROJECTS (tests)

The demo agent stays out of real folders in the UI. With `LATIS_DEMO_IN_PROJECTS=1` it can work in projects, so e2e tests can drive real file changes (worktrees, review, merge) without tokens.

### 2026-10-23: Workspace MCP server is stateless, with a token per chat

The server (`src/main/mcp/server.ts`) listens on `127.0.0.1` on a random port. Each chat gets its own random bearer token, made when its agent starts and kept for the app's lifetime. The token tells the server which chat is calling, which is what placement ("next to the caller") and the guardrails need. A single per-launch token couldn't tell callers apart.

The server is stateless Streamable HTTP with JSON responses: every POST gets a fresh `McpServer` bound to its caller, and GET/DELETE answer 405. Requests are refused when they carry an `Origin` header (browsers) or a `Host` other than 127.0.0.1/localhost on our port (DNS rebinding). The tools themselves live in `WorkspaceService` (`src/main/mcp/workspace.ts`), so they're tested without HTTP.

### 2026-10-23: How agents get the workspace tools

- Claude Code and Codex get the HTTP server directly (Claude: `mcpServers` with a `type: "http"` entry; Codex: `config.mcp_servers.latis` with `url`, `http_headers` and `tool_timeout_sec` on `thread/start`/`thread/resume`).
- ACP agents and the demo agent get the stdio shim `latis-mcp` (`out/main/latis-mcp.js`, run as Electron-as-Node), which forwards each line to the server. ACP only promises stdio MCP, so this works with any of them.
- `wait_for_chats` blocks, so tool timeouts are raised to 30 minutes (Codex `tool_timeout_sec`, Claude `MCP_TOOL_TIMEOUT`). The tool's own timeout tops out at 29.5 minutes.
- Calls to `latis` tools don't ask the user. Claude's `canUseTool` and the ACP permission handler allow them, except in read-only chats. The guardrails are in Latis instead.

### 2026-10-23: Workspace tool guardrails

- A spawned chat runs in the caller's permission mode. `spawn_chat` accepts `permission_mode` only if it's stricter.
- One caller may have at most `prefs.maxSpawned` chats (default 6) working or waiting at once (Settings → Conductor).
- `close_chat` works only on chats the caller spawned, and only after a native confirmation dialog. It soft-deletes, so the chat stays restorable from ⌘K.
- Every call shows in the caller's transcript as the agent's own MCP tool step. Latis doesn't add a second log.
- `wait_for_chats` returns as soon as no listed chat is working. A chat that needs the user counts as stopped and is reported with a note, so the Conductor can tell the user instead of hanging.

### 2026-10-23: Spec tools added and left for M6

Added `tidy_canvas` and `close_chat`. §10.2 asks the Conductor to tidy the canvas, and §10.1's guardrails talk about closing chats, but the tool table has neither. `create_card`/`update_card`/`create_flow` wait for cards and flows (M6). A folder that isn't a project yet becomes one when `spawn_chat` targets it.

### 2026-10-23: The Conductor

- The Conductor is an ordinary chat row with `role = 'conductor'`, created once at startup at the top left of the canvas.
- Its agent is the first one installed and signed in, in the order Claude Code, Codex, Gemini. It can be changed in Settings → Conductor, which starts a new conversation because a different agent can't resume the old one.
- It works in `<dataDir>/conductor/`. Its instructions are `resources/conductor/SYSTEM.md` (bundled) plus `<dataDir>/conductor/AGENTS.md` (the user's, opened from Settings). These go in as a system prompt append (Claude), `developerInstructions` (Codex), or with the first message (ACP, which has no system prompt).
- `softDelete` skips it, so it can't be deleted.
- E2E: `LATIS_SKIP_CONDUCTOR=1` (the default in `helpers.ts`) and `LATIS_CONDUCTOR_AGENT=<id>`.

### 2026-10-23: MCP connections and secrets

- Connections are stored in `mcp_servers`. Env values and headers are one JSON blob encrypted with `safeStorage`; the renderer only ever sees their key names. Where no keychain is available (`isEncryptionAvailable()` false, e.g. Linux without a keyring), saving a connection with secrets is refused rather than stored in plain text.
- Shared connections go to every chat whose agent supports MCP. Other connections are attached per chat from its ⋯ menu.
- Changes apply when the agent next starts. Toggling a connection or the workspace tools restarts the session, which resumes the conversation, but only between turns.
- The name `latis` is reserved.

**Import:** only after the user clicks Import, and only from a fixed list of files: Claude Desktop, `~/.claude.json`, Cursor, Gemini CLI, `~/.codex/config.toml`, VS Code. Latis reads only their MCP server section. Each server is shown with its command or URL and its key names before anything is copied.

**Not done:** OAuth sign-in for HTTP servers (§9.15 AC1). An agent that supports OAuth itself may still sign in on its own.

### 2026-10-23: Skills are expanded by Latis

A known `/name` in a message is replaced by `<skill name="…">…</skill>` blocks ahead of the text. The agent receives the expanded message; the transcript keeps what the user typed. Unknown `/words` (paths, agent slash commands, demo scripts) are left alone. A project's `.latis/skills/` wins over the user's `<dataDir>/skills/` on a name clash. `name:` and `description:` come from front matter when present.

### 2026-10-23: Codex approves Latis's tools; elicitations become approvals

Codex asks (`mcpServer/elicitation/request`) before any MCP tool that isn't marked read-only. For Latis's own server, Latis sets `default_tools_approval_mode = "approve"` (`McpServerConfig.trusted`). Other servers' elicitations are shown as ordinary permission requests and answered `accept`/`decline`. URL-mode elicitations (sign-in pages) aren't supported yet and are declined.

### 2026-10-23: Send later

- Scheduled messages live in a `scheduled` table and are checked every 15 s.
- A message more than 2 minutes late (Latis was closed) is sent once, with a `[Note from Latis]` saying when it was due.
- Repeats skip the slots they missed rather than sending a burst.
- "When the limit resets" is only offered once the agent has reported a limit with a reset time. Latis adds 1 minute of slack.
- A message is delivered like `send_message` mode "queue": sent if the chat is idle, otherwise after its turn.

### 2026-10-23: Usage meter

- **Where the numbers come from:**
  - Claude Code: `rate_limit_event.rate_limit_info.unifiedWindows` (utilisation 0–1, reset in seconds), sent with every turn, allowed or not.
  - Codex: `account/rateLimits/updated`, plus an `account/rateLimits/read` probe at startup and every 15 minutes. The probe starts no thread and spends no tokens.
  - Gemini (ACP) reports nothing, so it shows "—".
- These arrive as a `usage.window` event that the supervisor routes to the meter, not into the transcript.
- A `rate_limited` event marks the agent limited until its reset time passes or a later turn finishes cleanly.
- The meter is kept in settings, so the status bar has numbers after a restart.

### 2026-10-23: Handoff brief is built by Latis

§9.11 asks for a summary "generated by the outgoing agent if available, else by a short summarisation call on the incoming agent". Latis uses the outgoing agent's last report (its final message) as that summary. When there's none, the brief tells the incoming agent to summarise the changed files first, so the incoming agent's first step is the summarisation. That avoids an extra model call on an agent that's out of usage.

The brief contains:

- the first message and any later instructions from the user;
- the last report;
- the files changed (`chatDiff`: the worktree's branch, or first to last checkpoint);
- open TODOs: unchecked `- [ ]` items and `TODO:`/`Next:`/`Remaining:` lines from the last report and plans.

The new chat shares the old one's cwd and worktree row. It's marked `continued_from` and shows a "Continued from …" link in its header. A canvas edge between the two waits for flows' edges.

### 2026-10-23: Multiple accounts are separate CLI homes

An extra account is a folder under `<dataDir>/accounts/<agent>/<id>`. While it's active, the agent's CLI gets `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GEMINI_CLI_HOME` pointing at that folder.

- Sign-in runs the CLI's own login in a terminal with that variable set. Latis never reads the folder (§6.5).
- Switching waits until no chat of that agent is mid-turn, then restarts its sessions, which resume their conversations.
- Forgetting an account leaves its folder on disk.
- Second accounts haven't been signed in live yet. Gemini's `GEMINI_CLI_HOME` is taken from its bundle, not its docs.

### 2026-10-23: Cards

- **Isolation:** each card is served by a privileged `card://` scheme (`standard`, `secure`) at `card://<id>/`. It runs in `<iframe sandbox="allow-scripts allow-forms">`, so its security origin is opaque (`self.origin === "null"`): no storage, no access to the parent and no cookies. The renderer CSP adds `frame-src card:`.
- **CSP:** the card CSP is the one in §12.1. Latis doesn't add `form-action 'none'`, because it stopped in-page form submit handlers from firing in Chromium. The sandbox already keeps a form from navigating anything but the card itself.
- **Network:** origins a card may reach are exact `https` origins (or `http` on localhost) with plain host names. Wildcards are refused because they would widen the CSP. The user grants them in a native dialog that lists them, and the card reloads with the new `connect-src`.
- **Bridge:** `card://<id>/__latis.js` is injected at the top of `<head>`. It talks to the parent over `postMessage`.
  - The card node only answers messages whose `source` is its own iframe's window, so one card can't call for another.
  - `ask()` is handled in the renderer: it fills the Conductor's composer and the user still presses Send.
  - Theme tokens are sent on load and on every theme or accent change, and set as `--latis-*` CSS variables.
- **Refresh scripts:** `refresh.mjs` runs under Electron-as-Node in the card folder, with PATH, HOME, locale and temp variables only, for at most 60 s. It gets the card's data on stdin and its JSON stdout is merged into the data.
  - The user approves the script's exact text in a dialog. A changed script asks again (sha256).
  - `card://` never serves `refresh.mjs`.
- **PDF export:** the card is loaded in a hidden window with a one-time snapshot token, which makes the bridge answer from a read-only copy of the card's data and theme. It's printed to A4 and saved where the user picks.
- **Library and tools:** the six starters are bundled from `resources/cards` and copied into the card's folder, with a shared `base.css`. The Conductor's `create_card`/`update_card` write the same folder layout.
- **Not done:** §12.3's "unloaded after 30 s on non-visible canvases". There's only one canvas, and off-screen nodes are already unmounted by the virtualised canvas.

### 2026-10-23: Flows engine

- **What a flow is:** a frame node of type `flow` with a `flows` row (name, brief, schedule, next run, loop limit). Its members are the nodes parented to the frame: a new `start` node type, chats (their job is in the node's data), notes and cards (a gate card's kind is in the node's data and its card row). Edges live in `edges`, run state in `flow_runs`.
- **Outputs:** a chat's output is its final message for a turn the flow started, reported by a new supervisor hook (`turnEnded`). Turns the user starts in a flow chat don't route anywhere. A note passes what it receives on along its own edges. A gate card holds items in its data (`inbox`) until the user sends one on (`sendToFlow`). A results card collects (`items`).
- **Edge modes:** `free` gives an item to the first target that's idle (not busy, nothing in flight from this run), otherwise it queues until a turn ends. `wait_all` buffers one item per incoming `wait_all` edge, then delivers them together, each under a "## From <sender>" header.
- **Approval:** "Keep" can edit the text first. "Send back" re-runs the source chat with the feedback and its previous answer. "Drop" discards it.
- **Run controls:**
  - The loop guard counts every handoff in a run; "Continue" resets the count.
  - `[flow done]` in a chat's answer ends the run.
  - A run is done when nothing is in flight, waiting on approval or in a gate, queued or held.
  - Pause holds handoffs; Stop interrupts the run's chats and drops what's waiting.
- **Restarts:** after a restart, items that were in flight to chats are sent again, since those turns can't still be running.
- **Schedules:** checked every 15 s. A run due while Latis was closed happens once on launch, with a note in the run log, and the next run is the next slot after now. A scheduled run uses the Start node's saved input.
- **Building flows:** the builder lays nodes out by longest path from the Start node (cycles fall back to spec order). A spec can set `cwd` and `permissionMode`; without `cwd` the chats work in `<dataDir>/flows/<id>/`. `agent: "auto"` spreads chats across ready agents in the order Claude Code, Codex, Gemini.
- **Added beyond the spec:** a `start_flow` tool, so the Conductor can run what it builds. `LATIS_FLOW_AGENT=<id>` makes every flow chat use one agent (tests).
- **Not done:** flow chats raise "finished" Inbox items like any chat, which is noisy for big flows.

### 2026-10-23: Commands and rebindable shortcuts

Every keyboard action is a command in one registry (`renderer/commands`): an id, a title, a category, default chords, a scope (anywhere, canvas or lattice) and an optional condition. One dispatcher runs them; the old per-component key handlers are gone.

- **Chord notation:** written like `Mod+Shift+R`. `Mod` is ⌘ on macOS and Ctrl elsewhere. Letters and digits are read from `event.code`, so Shift and keyboard layouts don't change them.
- **Where chords fire:** plain-key chords (N, F, Delete…) never fire while typing or when a button or menu item has focus. Canvas and lattice commands only run in their view, with no dialog or menu open.
- **Ctrl on macOS:** an unclaimed Ctrl chord also triggers the ⌘ one, as before (Ctrl+` opens the dock).
- **Your changes:** overrides live in `prefs.keybindings`. Settings → Commands lists every command and lets you search it, add a shortcut by pressing keys, remove one, reset one or all, and see conflicts. Conflicts are chords shared in the same scope, or with an anywhere command.
- **⌘K** lists the same commands with their current shortcuts.

### 2026-10-23: The lattice

A second layout next to the canvas (`prefs.layoutMode`): every chat tiled in a tree of row and column splits, saved as `settings.lattice`.

- **New chats** split the largest pane along its longer side, so the tiling balances itself.
- **Rearranging:**
  - Drag a pane by its grip onto another pane's outer quarter to split there, or its centre to swap.
  - Drag a gutter to resize, with a minimum share of 8%; double-click it to even out.
  - Presets (grid shaped to the window, columns, rows, main + stack) keep the panes in on-screen reading order.
- **Keyboard:** focus and move are geometric (nearest pane in that direction). The focused pane is the selected chat, so chat commands act on it.
- **Taking a chat out** only hides it from the lattice; it stays on the canvas.
- **Why a grip:** narrow panes' headers are mostly buttons, so each pane has a dedicated drag grip.

### 2026-10-23: Visual pass

- Chats take a wash of their agent's colour (`--tint`): on the top of the card, the border, the header and your message bubbles. It can be turned off (Appearance → Tint chats by agent).
- Your messages are right-aligned bubbles.
- The canvas has a floating toolbar (fit, zoom, tidy, label, note, card, flow, undo/redo) and section labels (a `label` node type).
- **Sidebar:** Workspace (Canvas, Lattice, focus views), loose chats (the Conductor and demo chats now appear), collapsible projects. The Files tab is now a filterable file list.
- **Design:** influenced by the reference screenshots (tinted cards, floating toolbar, section pills) but keeps Latis's own identity: the teal accent, the lattice motif and its own layout.
- **Bug found:** the tint CSS first used a non-existent `--line` token, which made borders fall back to the text colour. The card bridge had the same mistake. Both use `--border` now.

### 2026-10-23: Focus mode is called "Lock In"

At the user's request, the focus views of §8.7 are called **Lock In** everywhere a person or agent reads it: the title-bar button and tabs, the command ("Lock In on the selected chats", F), the view's labels, the `focus` tool's description and the Conductor's prompt. The code keeps its `FocusView`/`focus` names. "Focus" still means keyboard focus where that's the sense (the focused pane in the lattice).

### 2026-10-23: Two-finger scroll pans the canvas

The wheel zoomed the canvas for one version. Trackpads send two-finger scroll as wheel events, which made moving around hard, so panning is the default again. Pinch and ⌘/Ctrl + wheel zoom. Appearance → Scroll wheel → Zoom keeps the other behaviour for mouse users who want it.

### 2026-10-24: Transcripts follow streaming output until the user scrolls up

Virtuoso's `followOutput` only reacts to new items, so a reply growing in place (streamed text, tool output) left the view behind. `chat/followOutput.ts` keeps a "stuck" flag: on by default and after sending; off on wheel-up, Up/PageUp/Home, or an upward scrollbar/touch drag; on again when the user reaches the bottom (24 px). While stuck, any growth of the list or resize of the viewport pins it to the bottom. One component, so this covers the canvas, the lattice and lock-in.

### 2026-10-25: The lattice is the workspace; the canvas is the map

At the user's request the app opens on the lattice (`layoutMode` default `"lattice"`, ⌘1; the canvas moved to ⌘2 and second place in the title bar and sidebar). Existing data dirs are moved over once (`designV2` setting), which also swaps the old default accent Aurora for Glacier. `LATIS_LAYOUT=canvas` starts on the canvas; the e2e helper sets it because most specs drive the canvas. The canvas stays for seeing how chats, notes, cards and flows relate.

Working with several agents happens in the lattice:

- **Agent strip** in the toolbar: one button per installed agent starts a chat in the target project (the filter, else the focused pane's, else the only project) and tiles it in.
- **Split** on each pane: a new chat with any agent, in the same project, placed right of or below that pane (⌘\ and ⌘⇧\ use the same agent).
- **Broadcast bar** (⌘⇧A): one message to every selected pane; chats mid-turn are steered. Terminal agents are left out.
- **Pass** on each pane: put its latest reply into another pane's composer (to add an instruction), or send it to every other pane with a request to review it.

### 2026-10-25: Cold, sharp visual language

Radii are 2–3px (`--radius-*`), pills became squares (status dots keep their shapes for accessibility, §8.12), shadows became hairlines, the palette moved to blue-steel greys with an ice-blue accent (Glacier). Agent colour is a 2px rule on the chat header and on your messages instead of a wash. Toolbar labels use `.latis-caps` (mono, uppercase). Lattice panes sit 4px apart on `bg-0`; the focused one gets a 1px accent outline.

### 2026-10-26: The always-ask list is enforced per agent; Settings → Permissions

§9.8 AC3 names examples but not a matching rule or defaults. Defaults: `git push`, `rm -rf`, `npm publish`, `pnpm publish`, `git reset --hard`, `sudo`. Matching (`packages/shared/src/always-ask.ts`) errs towards asking: the command line is split into simple commands (quotes honoured; `;`, `&&`, `|`, `$(…)`, backticks and the script of `sh -c`/`bash -lc`/`eval` all count); a pattern matches when its first word is a program in a command (by basename, so `sudo rm` and `/usr/bin/git` count) and its other words follow in any order. Short flags compare as letter sets (`rm -rf` = `-fr` = `-r -f` = `-Rf`, with `--recursive`/`--force`), long flags also match `--flag=value` and longer spellings. The pattern as whole words anywhere in the line also matches (`echo git push` asks; `pseudo` doesn't match `sudo`).

Per agent: Claude Code through a PreToolUse hook, Codex by switching Full-auto to `untrusted` approvals while the list isn't empty, ACP by running the agent's auto-edit mode in Full-auto and checking `execute` requests (only what the agent asks about, so ACP keeps its header warning), terminal agents not at all. A listed command never offers "Always for this chat". Read-only chats are left alone (they refuse commands anyway). Details in `docs/adapters/*.md`.

Settings → Permissions holds the default mode for new chats (moved from its own setting into `Prefs.defaultPermissionMode`, read once for old data dirs), the list with a "Try a command" box, and which agents the list covers. Not done from §8.11/§9.8 AC4: per-project overrides, and listing/revoking "always allow" grants (they live in each agent's session today).

### 2026-10-26: Claude in public builds: the terminal on the user's sign-in, the chat view on an API key

Anthropic's Agent SDK overview says third-party products may not offer claude.ai login or rate limits unless approved, and points to API keys ([source](https://code.claude.com/docs/en/agent-sdk/overview)). Its support article still lets people use the SDK within their own plan's limits ([source](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Latis is going public as a free GitHub repo, so:

- **Claude Code (`terminal:claude`)**, the default way to use a subscription, runs the user's own `claude` in its own terminal UI. Latis only adds a settings file of HTTP hooks (docs/adapters/claude-code.md → Terminal), which brings back status, Inbox approvals, the always-ask list, turns and checkpoints, resume and workspace tools.
- **Claude (`claude-code`, the chat view)** needs an Anthropic API key in release builds. The key is kept in the OS keychain via `safeStorage`, or taken from `ANTHROPIC_API_KEY` in the shell. Renamed from "Claude Code" per the SDK branding rules.
- **Personal use:** running from source and `LATIS_PERSONAL=1 pnpm package` builds keep the chat view on the user's own sign-in. Release CI never sets the flag.
- **Approval:** asking Anthropic for approval of subscription login in the chat view is open for later.

OpenAI: nothing found that addresses third-party Codex app-server clients on a ChatGPT sign-in ([Codex auth](https://developers.openai.com/codex/auth), [Codex with ChatGPT](https://help.openai.com/en/articles/11369540)). Codex keeps its own sign-in. Re-check before each release.

### 2026-10-26: A release notice instead of auto-update, for now

Auto-update needs signed builds (macOS won't swap in an unsigned app, Windows shows SmartScreen), and signing waits until there's demand. So installed copies ask GitHub's releases API (`/repos/kornel77777/latis/releases/latest`):

- **When:** 10 s after launch, then every 6 hours.
- **What it shows:** a link in the status bar and in Settings → General, plus a toast the first time a version appears. Nothing is downloaded.
- **What it offers:** only a newer tag whose page is on `github.com/kornel77777/latis/releases/`. Drafts and pre-releases never count, since `latest` excludes them. A 404 (no releases yet, or a private repo) means nothing to offer.
- **Turning it off:** Settings → General → "Check for new versions". The request carries no user data, only the app version in the User-Agent.
- **Where it doesn't run:** dev runs never check. `LATIS_UPDATE_FEED` points tests at a local server.

### 2026-10-26: Crash reports and diagnostics stay local; "Report a problem" goes through the user

§13 allows opt-in crash reports. Rather than run a crash service, Latis keeps everything on the machine:

- **Logs:** main-process warnings and errors, uncaught exceptions and renderer crashes go to `<dataDir>/logs/latis.log`, scrubbed of home paths, bearer tokens, `sk-` keys, `key=value` secrets and emails, and rotated at 1 MB.
- **Crash dumps:** Electron's `crashReporter` runs with `uploadToServer: false`.
- **Report a problem** (title-bar menu, ⌘K, Settings → General) copies diagnostics to the clipboard: version, OS, installed agents and the scrubbed log tail. It then opens a GitHub new-issue page with only the version and OS filled in, so nothing goes into the URL beyond that, and the user decides what to paste.

Settings → Data:

- **Open:** opens the data folder.
- **Export:** `VACUUM INTO` a copy with the API key and MCP secrets removed, plus cards, skills, Conductor preferences, manifests and sandbox projects. Sign-ins, tokens, logs and the browser profile are left out.
- **Not done:** a "reset everything" button. The docs say to quit and delete the folder; moving an open SQLite database to the Trash isn't worth the risk.

Everything that leaves the machine is listed in `docs/privacy.md`.
