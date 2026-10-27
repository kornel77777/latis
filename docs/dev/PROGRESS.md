# Progress

## Since M6 (2026-10-24)

- The lattice is the default workspace (⌘1); the canvas is the map (⌘2). Agent strip, split-with-agent, broadcast bar and pass/review between panes; e2e in `e2e/lattice.spec.ts`.
- New cold, sharp look (2px radii, hairlines, Glacier accent).
- Known: `m1.spec.ts` title check flaked once in a full run (passes alone); the canvas doesn't yet draw relationships (spawned-by, handoff, passed replies) as edges.
- Chat transcripts follow a streaming reply in every view (canvas, lattice, lock-in) and stop following when the user scrolls up; e2e in `e2e/lattice.spec.ts`.
- M7 has started (link policy, fuses, signing/notarization config, icon); auto-update, privacy doc, docs site, crash-report opt-in, perf and security passes and signed installers are still open.
- 2026-10-26: **Performance and security pass** (M7, `docs/qa/M7.md`). Fixed:
  - web permissions were open to cards; now only clipboard write, for Lattiz's own page
  - `<webview>` blocked
  - release CSP without the dev socket
  - endless status-bar animations: idle CPU went from about 2% to 0.03%
    Within budget: cold start 0.6 s, p95 frame 9 ms. Memory is near the 600 MB line. Tests: 182 unit, 46 native, 29 e2e.
- 2026-10-26: **Privacy and diagnostics** (M7): `docs/privacy.md`; Settings → Data (open folder, export without secrets); local scrubbed log file and crash dumps (never uploaded); "Report a problem" copies diagnostics and opens a GitHub issue. Tests: 179 unit, 46 native, 28 e2e.
- 2026-10-26: **Release notice** (M7, instead of auto-update for now): installed copies check GitHub Releases every 6 h and link to a newer version from the status bar and the new Settings → General (version, Check now, off switch). Tests: 173 unit, 45 native, 27 e2e.
- 2026-10-26: **Claude, two ways** (DECISIONS 2026-10-26):
  - **Claude Code** runs the user's own `claude` in a terminal tile on their subscription. HTTP hooks give it status, Inbox approvals (answer in the terminal or Lattiz), the always-ask banner, recorded turns with checkpoints, resume after restart, and workspace tools.
  - **Claude** (the chat view) needs an API key in release builds; dev runs and `LATTIZ_PERSONAL=1` builds keep the user's sign-in.
  - The Conductor, flows and handoff can use the terminal Claude.
  - Live-tested against Claude Code 2.1.310 (`e2e/live-claude-terminal.spec.ts`).
  - Tests: 158 unit, 45 native, 26 e2e.
- 2026-10-26: **The always-ask list is enforced** (§9.8 AC3), including Full-auto: Claude Code through a PreToolUse hook and Codex through `untrusted` approvals (both verified live, recorded in `fixtures/claude-code/always-ask-bypass.jsonl` and `fixtures/codex/full-auto-always-ask.jsonl`); ACP agents when they ask before a command; terminal agents not at all (header warns). **Settings → Permissions**: default mode for new chats, the list (defaults `git push`, `rm -rf`, `npm publish`, `pnpm publish`, `git reset --hard`, `sudo`) with a "Try a command" box, and per-agent coverage. Tests: 148 unit, 45 native, 25 e2e (`e2e/permissions.spec.ts`). Still open from §9.8 AC4: listing and revoking "always allow" grants; per-project overrides; Gemini's execute permissions not recorded live.

## Current: M6 Power features: done 2026-10-23

Exit criteria: **S5** and **S6** pass. The e2e runs use the demo and replayed agents; the live runs used Claude Code and Codex (`e2e/live-m6.spec.ts`). Details are in `docs/qa/M6.md`.

### Done

- **Send later (§9.10):**
  - Right-click Send or press the clock: 30 min / 1 h / 3 h / tomorrow 09:00 / a time / when the limit resets, with repeats.
  - A countdown list sits above the composer.
  - Messages survive restarts; missed ones go out once with a note.
- **Limits and handoff (§9.10–9.11):**
  - The limit banner offers "Send when it resets", "Continue with another agent…" and Dismiss.
  - The handoff brief has the goal, the last report, the changed files and the TODOs, and can be edited. The new chat starts beside the old one in the same folder or worktree, linked "Continued from".
  - The model picker has "Continue with…" too.
- **Usage meter (§9.12):**
  - Status-bar windows per agent: Claude 5h/7d, Codex 5h/7d (probed without tokens), Gemini "—".
  - Limited agents show in red with their reset time.
  - Multiple accounts per agent as separate CLI homes: add, label, switch (waits for running turns), forget.
- **Cards (§12):**
  - `card://` origin per card in a sandboxed iframe, no network unless granted per origin.
  - The `window.lattiz` bridge: data, refresh, ask, exportPdf, theme, usage.
  - Refresh scripts are approved per version and run without secrets.
  - PDF export.
  - Six bundled starters: Habit tracker, Countdown, Kanban, Repo dashboard, Usage dashboard, Pomodoro.
  - `create_card`/`update_card` for agents.
- **Flows (§11):**
  - Start / chat (with a job) / note / card nodes; every / free / wait_all / approval edges.
  - Brief, loop guard, `[flow done]`, pause / resume / stop, run log, persisted runs that resume after a restart.
  - Hourly, daily and weekly schedules.
  - Five gate cards.
  - Five templates: Council, Review ×3, Pipeline, Team, Daily digest.
  - `create_flow`/`start_flow` for the Conductor.
  - Edges and connect handles on the canvas.
- **Tests:** 102 unit, 45 native, 24 e2e (+ live M5/M6, opt-in).

### Not done / known issues

- A second account per agent hasn't been signed in live.
- Flow chats raise "finished" Inbox items (noisy in big flows).
- The handoff link is a header chip, not a canvas edge.
- Gemini still isn't verified live as a workspace-tools caller (its free quota ran out).

## M5 Orchestration: done 2026-10-23

Exit criterion: **S4 with a real agent as Conductor** passes (`e2e/live-m5.spec.ts`). Claude Code conducted Claude Code, Codex and Gemini reviewers and wrote the "where they agree" note in 49 s. The same flow runs in CI with the demo agent (`e2e/m5.spec.ts`). Details are in `docs/qa/M5.md`.

### Done

- **Workspace MCP server (§10.1):**
  - Streamable HTTP on 127.0.0.1 with a bearer token per chat. Stateless, refuses browsers.
  - Tools: `list_projects`, `list_chats`, `read_chat`, `spawn_chat`, `send_message`, `wait_for_chats`, `get_diff`, `create_note`, `append_note`, `focus`, plus `tidy_canvas` and `close_chat`.
  - Guardrails: spawned chats get the same or a stricter mode, a per-caller running limit, closing only your own chats after the user confirms.
  - The `lattiz-mcp` stdio shim for agents that only speak stdio.
- **Agents get MCP servers:** Claude Code (`mcpServers`, `MCP_TOOL_TIMEOUT`), Codex (`config.mcp_servers`, `developerInstructions`, approval mode, MCP elicitations shown as approvals), ACP (`mcpServers` in `session/new`/`load`, instructions with the first message), and the demo agent (scripted tool calls).
- **Conductor (§10.2):**
  - A pinned chat at the top left, on the first ready agent of Claude Code, Codex, Gemini.
  - `resources/conductor/SYSTEM.md` plus the user's `AGENTS.md`.
  - Settings → Conductor (agent, preferences, spawn limit), starter prompts, "Ask the Conductor" in ⌘K.
- **Give workspace tools** on any chat (⋯ menu and ⌘K). Agent-spawned chats, notes, focus views and tidy-ups appear on the canvas live.
- **MCP connections (§9.15):**
  - stdio or HTTP, with env and headers encrypted with safeStorage.
  - "Share with every chat", or attach per chat from the ⋯ menu.
  - Import from Claude Desktop, Claude Code, Cursor, Gemini CLI, Codex and VS Code, only on click and with a preview.
- **Skills (§9.14):**
  - `<dataDir>/skills/*.md`, `<project>/.lattiz/skills/`, and SKILL.md folders.
  - `/name` suggestions in the composer; the agent receives the skill text.
  - Settings → Skills with import.
- **Tests:** 96 unit, 31 native, 21 e2e (+ live S4 and live Codex tools, opt-in).

### Not done / known issues

- Gemini using the workspace tools through the shim hasn't been run live (its free-tier quota ran out). Gemini's ACP mode retries silently on 429, so such a turn looks like it's still working.
- No OAuth sign-in for HTTP MCP servers.
- `create_card`, `update_card` and `create_flow` come with M6.
- The Conductor isn't listed in the sidebar's project tree (it isn't in a project). Reach it with ⌘K → "Ask the Conductor".

## M4 The great UI: done 2026-10-23

Exit criteria: **S1 keyboard-only** passes (`e2e/m3.spec.ts`). **Design review against §8**: `e2e/design.spec.ts` captures both themes; findings are fixed and listed in `docs/qa/M4.md`. CI is green on all three OSes (Linux check + macOS/Windows/Linux packages).

### Done

- **Semantic zoom (§8.4):** condensed cards and status tiles (state, current action, elapsed, pending approvals), with click to zoom in. Frames have a zoomed-out label. Virtualised canvas, a perf overlay (Ctrl+Alt+P), keyboard zoom.
- **Canvas:**
  - Markdown notes (N), exportable as .md. Soft delete with ⌘K restore for 7 days; canvas undo/redo.
  - Frame toolbar: new chat, terminal, open, fit, colour, rename, remove, Locate a moved folder.
  - Tidy up, select all, and nodes that animate in.
- **Command palette (§8.8, §9.16):**
  - Fuzzy actions, the selected chat's own actions, projects, chats, notes, project files, settings, restore.
  - FTS5 search over what was said and written.
- **Focus mode (§8.7):** Grid / Stage / Columns, saved as title-bar tabs; distraction-free (Ctrl/⌘+Shift+F).
- **Dock browser (§9.7):** dev-server detection, devices with touch, a "Nothing running" page, and the element picker into a chat. Image attachments in the composer, pasted or picked.
- **Appearance (§8.11):** accent, interface size, chat text, density, glass cards, grid, wallpaper, reduce motion.
- **Accessibility:** WCAG AA colours, spoken announcements, keyboard paths throughout.
- **Onboarding:** the getting-started checklist.
- **Tests:** 93 unit, 19 native, 19 e2e (+ live, perf and design specs, opt-in).

### Not done / known issues

- Image attachments aren't kept in the stored transcript.
- The canvas undo stack isn't persisted.
- The picker screenshot is imprecise in device presets.
- Title-bar tab split and new windows; align/distribute, snapping and smart guides.
- The always-ask list is still not enforced in Full-auto; no Settings → Permissions yet.

## Next: M5 Orchestration

Workspace MCP server + stdio shim (§10.1), Conductor (§10.2), "Give workspace tools" on any chat, MCP connections (§9.15), skills (§9.14). Exit: scenario S4 with a real agent as conductor.

## M3 Safe changes: done 2026-10-23

Exit criterion **S1 passes live** (`e2e/live-m3.spec.ts`). Claude Code and Codex worked in separate worktrees, the user was notified as each finished, both diffs were reviewed in the Review Inbox, and both were merged into `main`.

### Done

- **Git service** (`src/main/git/`): snapshot commits through a throwaway index, so the user's index and HEAD are untouched. Also: diffs, restoring paths, single-hunk revert, worktrees, `merge-tree` dry runs, safe removal.
- **Checkpoints (§9.4):** before/after every turn on hidden refs. Undo/redo in the turn footer; a Timeline dialog with "restore to before this turn". The agent is told with the next message.
- **Review Inbox (§9.5):**
  - Every turn that changed files becomes an item (agent summary, files, +/−).
  - Full-screen panel (`Ctrl/⌘+Shift+R`) with project/agent filters, unified/split diffs highlighted by Shiki.
  - Per-file and per-hunk Accept/Revert, Accept all, mark reviewed, "Ask for changes" quoting the hunk.
  - Count shown in the sidebar.
- **Worktrees (§9.3):**
  - The offer for a second chat in a repo, plus "Work in its own copy" for any chat.
  - Branch chip with Review changes, Merge (merge or squash, dry run first, conflicts with "ask the agent to resolve"), and Remove copy (refuses unmerged work unless confirmed).
  - "Initialise git" for plain folders.
- **Tests:** 82 unit, 17 native (including S1 at the service level), 12 e2e (3 new for M3), and live S1.

### Not done / known issues

- CI: the Linux check (lint, types, unit, native, e2e under xvfb) and the macOS/Linux packaging pass. Windows packaging failed on `windows-latest` (node-gyp couldn't find Visual Studio); now pinned to `windows-2022`, pending a green run.
- Snapshots on very large repos haven't been timed. Binary files have no hunk actions.
- A Claude chat moved into its own copy can't resume its old conversation (Claude sessions are per-folder); it starts a new one.
- The always-ask list still isn't enforced in Full-auto.
- Gemini verified live 2026-10-23 (sign-in through Lattiz, recordings, six-chat run). That run had 3 frames over the 32 ms budget (max 125 ms); investigate in the M4 perf pass.

## M2 Many agents: done 2026-10-23 (Gemini verified live the same day)

Exit criteria, live against real agents (`e2e/live-m2.spec.ts`): **S3**: a Codex command approval answered from the Inbox. **S2**: a correction steered into a running Claude Code turn and followed without stopping it. **Six chats across three agents** (Claude Code, Codex, and an ACP agent added by manifest) streaming at once: p95 frame 9.1 ms, max 17.3 ms, none over 32 ms, 614 MB. The third agent was the Claude ACP bridge, not Gemini, because Gemini CLI isn't signed in on this machine. Gemini's ACP path is replay-tested and `initialize`-verified only.

### Done

- **Verified first:** Codex app-server (`docs/adapters/codex.md`, 6 recordings), ACP (`docs/adapters/acp.md`, 4 recordings through the Claude ACP bridge; Gemini `initialize` checked), Claude steering (`priority: "next"`). Recorders in `apps/desktop/scripts/`.
- **Adapters:**
  - Codex: steer, interrupt, resume, approvals, questions, models/effort, account check.
  - ACP (Gemini built-in + any manifest): modes by name or emulated, model/effort via config options, `session/load` resume.
  - Terminal-only (any CLI in a PTY), with a status detector driving status and the Inbox.
- **Manifests:** `<dataDir>/agents/*.json`; errors are shown in Settings.
- **Steering and queue (§9.9):** steer when the agent supports it, otherwise a "Next step" queue with edit, remove and Send now.
- **Attention (§8.6):**
  - Inbox tab grouped by project, with inline Allow/Deny.
  - Ctrl+J / Ctrl+Shift+J.
  - Native notifications with Allow/Deny on macOS; the dock badge counts needs-you items.
  - Status bar and sidebar counts mirror the Inbox.
- **Terminal dock (§9.6):**
  - Terminals per project with your login shell, using node-pty and xterm (WebGL, search, links).
  - Terminals survive remounts and warn before quitting while busy.
  - Open-as-terminal per chat.
- **Onboarding and Settings (§8.10, §8.11):**
  - Welcome → agents (install command, sign in through the agent's own login in a terminal) → folder or sandbox project → chats with starter drafts.
  - Settings → Agents and Notifications.
- **Tests:** 77 unit, 12 native, 9 replay e2e (also passing against the packaged `.app`), and 3 live tests plus the M1 live test (opt-in).

### Not done / known issues

- Gemini live: sign in (Settings → Agents → Gemini CLI → Sign in), then re-run `live-m2` and record `fixtures/acp/gemini-*.jsonl`.
- CI still not run (no GitHub remote); Windows/Linux unverified (node-pty and the badge differ there).
- The always-ask list isn't enforced in Full-auto for any agent yet (chat header warns). There's no Settings → Permissions yet.
- The queue isn't persisted across restarts. Codex `item/tool/requestUserInput` is mapped but not recorded live.
- Built-in terminal manifests (Copilot, OpenCode, Grok, Aider) are unverified against the real CLIs.
- A Playwright run couldn't type into composers at very low zoom (see docs/qa/M2.md).

## M1 First real agent: done 2026-10-22

Exit criterion met **live** against Claude Code 2.1.309 (Haiku 5.5), both from `out/` and from the packaged `Lattiz.app`: open a repo → chat with Claude Code → approve a request → see the edit as an inline diff → restart the app → the conversation resumes (`e2e/live.spec.ts`, opt-in with `LATTIZ_LIVE=1`).

### Done

- **Verified integration first** (`docs/adapters/claude-code.md`): SDK types, five recorded real streams in `fixtures/claude-code/` (permission allow/deny, two-turn edit, AskUserQuestion, plan mode), plus live probes of interrupt and resume. Recorder: `apps/desktop/scripts/record-claude-stream.mjs`.
- **Claude Code adapter** (`src/main/agents/adapters/claude-code/`): streaming-input session, `canUseTool` round-trips (permission / question / plan), relative paths, diff hunks from `structuredPatch`, per-turn cost deltas, rate-limit events, interrupt, live model / effort / permission-mode changes, resume by native session id, read-only mode enforced in `canUseTool`. Drives the user's own `claude` found via the login shell PATH.
- **Supervisor**: resume on restart, forgets un-resumable session ids with a clear message, records start failures in the chat, auto-titles from the first message until renamed.
- **Projects**: Open folder → project frame on the canvas (React Flow sub-flow); chats placed in free slots, frame grows; sidebar project tree with live status counts; "Folder missing" state; reveal in Finder.
- **Chat card** (§8.5): markdown with Shiki highlighting in a web worker (JS regex engine, no WASM); virtualised transcript (react-virtuoso); step rows with tool icons, clickable paths, IN/OUT; inline unified diffs with +/− stats; permission (once / always for chat / deny / deny with reason), multi-question, plan blocks that collapse once answered; turn footer with duration, tokens, API-equivalent cost; copy; model, effort and permission pickers; rename; stop; Full-auto warning where the always-ask list can't be enforced.
- **Agents**: detection + install hint + sign-in status, model lists fetched without spending tokens, "Re-check agents".
- **Replay mode** (`LATTIZ_CLAUDE_REPLAY=<fixtures dir>`): e2e tests drive the real adapter path through the UI from recordings.
- Tests: 34 unit (incl. 15 replaying real Claude streams), 7 native (store, EventLog, supervisor resume/title/failure), 5 e2e + 1 opt-in live.

### Not done / known issues

- **CI not yet run** (no GitHub remote). Linux e2e under xvfb and Windows/Linux packaging unverified.
- "Always for this project" is treated like "Always for this chat" (session-scoped). Project-scoped rules stored by Lattiz come with Settings → Permissions.
- The always-ask list isn't enforced in Full-auto for Claude Code yet (needs a PreToolUse hook). The chat header warns.
- Open-as-terminal (§9.2 AC5) needs the terminal dock (M2).
- Thinking text is shown when Claude returns a summary; the model may still return it empty.
- Renderer bundle is large (Shiki grammars are split into lazy chunks, but the main chunk is ~1.6 MB). Revisit in the perf pass.

## M0 Foundation: done 2026-10-22 (3-OS CI still unverified)

### Done

- pnpm monorepo: `apps/desktop` (electron-vite), `packages/shared`, `packages/ui`; strict TS, ESLint (typescript-eslint strict), Prettier.
- IPC contract (`packages/shared/src/ipc-contract.ts`) with zod; main validates every request, renderer validates every event; failures cross IPC as data. Typed `window.lattiz` from a sandboxed CJS preload.
- AgentEvent union (§6.2) and adapter interfaces (§6.1) in `packages/shared`.
- SQLite + drizzle (`canvases`, `nodes`, `chats`, `turns`, `events`, `settings`); bundled migrations tracked by `user_version`.
- EventLog: in-memory seq, 250 ms batched writes, flush on turn end, retry on failure.
- Main→renderer events coalesced every 16 ms (deltas concatenated); renderer applies them once per animation frame.
- SessionSupervisor: agent crash → chat `error` + Restart; never crashes the app.
- FakeAdapter (§6.6): a real child process speaking JSON lines; scripts in `fixtures/fake/` (stream, steps, permission round-trip, real file write, crash).
- Design tokens (dark + light), Inter / JetBrains Mono bundled, Button/Chip/Menu/Dialog/StatusDot primitives.
- Shell: title bar (canvas tab, search placeholder, settings/theme), sidebar (`Ctrl/⌘+B`), dock (`` Ctrl/⌘+` ``), status bar with live state counts.
- Canvas: React Flow pan/zoom 10–400%, marquee select, Space/middle-drag pan, minimap, zoom badge, `Shift+1/2`, `0`; viewport + node geometry persisted (300 ms debounce).
- Minimal chat card: header + status, streamed transcript, collapsible steps, file changes, inline permission (allow/deny), turn footer, composer, stop, restart.
- Tests: 18 Vitest (schema, status machine, coalescing, transcript, IPC validation, fake scripts, migrations, store, EventLog) + 3 Playwright e2e (stream → permission → restart persistence; crash → restart; theme persists). The e2e suite also passes against the packaged `.app` (`LATTIZ_E2E_EXECUTABLE=…`).
- `pnpm package` → unsigned `Lattiz.app` (app.asar 12 MB) launches and works.

### Not done / known issues

- **CI not yet run**: `.github/workflows/ci.yml` is written but there is no GitHub remote. The Linux e2e under xvfb and the Windows/Linux builds are unverified.
- Renderer bundle is ~1.4 MB unsplit; fine for now, revisit in M4/M7 perf pass.
- Transcript isn't virtualised yet (react-virtuoso lands with the full chat card in M1).
- No app icon yet (§18 Q1).
