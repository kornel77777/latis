# Progress

## Current: M3 Safe changes: done 2026-10-23

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

- CI's first run is in progress (Linux e2e slow/hanging; see below once it finishes). Windows/macOS packaging in CI unverified.
- Snapshots on very large repos haven't been timed. Binary files have no hunk actions.
- A Claude chat moved into its own copy can't resume its old conversation (Claude sessions are per-folder); it starts a new one.
- The always-ask list still isn't enforced in Full-auto. Gemini's live run still needs a sign-in.

## Next: M4 The great UI

Semantic zoom, focus mode, command palette + FTS search + restore, frames polish, smart placement, notes, browser dock + element picker, appearance settings, accessibility pass, onboarding checklist. Exit: design review against §8 and a keyboard-only S1.

## M2 Many agents: done 2026-10-23 (Gemini live run pending a sign-in)

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

Exit criterion met **live** against Claude Code 2.1.309 (Haiku 5.5), both from `out/` and from the packaged `Latis.app`: open a repo → chat with Claude Code → approve a request → see the edit as an inline diff → restart the app → the conversation resumes (`e2e/live.spec.ts`, opt-in with `LATIS_LIVE=1`).

### Done

- **Verified integration first** (`docs/adapters/claude-code.md`): SDK types, five recorded real streams in `fixtures/claude-code/` (permission allow/deny, two-turn edit, AskUserQuestion, plan mode), plus live probes of interrupt and resume. Recorder: `apps/desktop/scripts/record-claude-stream.mjs`.
- **Claude Code adapter** (`src/main/agents/adapters/claude-code/`): streaming-input session, `canUseTool` round-trips (permission / question / plan), relative paths, diff hunks from `structuredPatch`, per-turn cost deltas, rate-limit events, interrupt, live model / effort / permission-mode changes, resume by native session id, read-only mode enforced in `canUseTool`. Drives the user's own `claude` found via the login shell PATH.
- **Supervisor**: resume on restart, forgets un-resumable session ids with a clear message, records start failures in the chat, auto-titles from the first message until renamed.
- **Projects**: Open folder → project frame on the canvas (React Flow sub-flow); chats placed in free slots, frame grows; sidebar project tree with live status counts; "Folder missing" state; reveal in Finder.
- **Chat card** (§8.5): markdown with Shiki highlighting in a web worker (JS regex engine, no WASM); virtualised transcript (react-virtuoso); step rows with tool icons, clickable paths, IN/OUT; inline unified diffs with +/− stats; permission (once / always for chat / deny / deny with reason), multi-question, plan blocks that collapse once answered; turn footer with duration, tokens, API-equivalent cost; copy; model, effort and permission pickers; rename; stop; Full-auto warning where the always-ask list can't be enforced.
- **Agents**: detection + install hint + sign-in status, model lists fetched without spending tokens, "Re-check agents".
- **Replay mode** (`LATIS_CLAUDE_REPLAY=<fixtures dir>`): e2e tests drive the real adapter path through the UI from recordings.
- Tests: 34 unit (incl. 15 replaying real Claude streams), 7 native (store, EventLog, supervisor resume/title/failure), 5 e2e + 1 opt-in live.

### Not done / known issues

- **CI not yet run** (no GitHub remote). Linux e2e under xvfb and Windows/Linux packaging unverified.
- "Always for this project" is treated like "Always for this chat" (session-scoped). Project-scoped rules stored by Latis come with Settings → Permissions.
- The always-ask list isn't enforced in Full-auto for Claude Code yet (needs a PreToolUse hook). The chat header warns.
- Open-as-terminal (§9.2 AC5) needs the terminal dock (M2).
- Thinking text is shown when Claude returns a summary; the model may still return it empty.
- Renderer bundle is large (Shiki grammars are split into lazy chunks, but the main chunk is ~1.6 MB). Revisit in the perf pass.

## M0 Foundation: done 2026-10-22 (3-OS CI still unverified)

### Done

- pnpm monorepo: `apps/desktop` (electron-vite), `packages/shared`, `packages/ui`; strict TS, ESLint (typescript-eslint strict), Prettier.
- IPC contract (`packages/shared/src/ipc-contract.ts`) with zod; main validates every request, renderer validates every event; failures cross IPC as data. Typed `window.latis` from a sandboxed CJS preload.
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
- Tests: 18 Vitest (schema, status machine, coalescing, transcript, IPC validation, fake scripts, migrations, store, EventLog) + 3 Playwright e2e (stream → permission → restart persistence; crash → restart; theme persists). The e2e suite also passes against the packaged `.app` (`LATIS_E2E_EXECUTABLE=…`).
- `pnpm package` → unsigned `Latis.app` (app.asar 12 MB) launches and works.

### Not done / known issues

- **CI not yet run**: `.github/workflows/ci.yml` is written but there is no GitHub remote. The Linux e2e under xvfb and the Windows/Linux builds are unverified.
- Renderer bundle is ~1.4 MB unsplit; fine for now, revisit in M4/M7 perf pass.
- Transcript isn't virtualised yet (react-virtuoso lands with the full chat card in M1).
- No app icon yet (§18 Q1).
