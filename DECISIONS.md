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
