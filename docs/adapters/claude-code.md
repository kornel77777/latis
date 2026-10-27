# Claude Code adapter: verified integration notes

Verified 2026-10-22 against `@anthropic-ai/claude-agent-sdk@0.3.309` and Claude Code CLI `2.1.309` (macOS arm64), from the package's `sdk.d.ts` / `sdk-tools.d.ts` and real recorded streams in `fixtures/claude-code/`. Re-verify when bumping the SDK (SPEC §0.2).

## Integration

- `query({ prompt: AsyncIterable<SDKUserMessage>, options })` returns a `Query` (an async iterator of `SDKMessage` plus control methods). Streaming input keeps one CLI process alive across turns: push a user message per turn, read until `type: "result"`.
- **Executable.** The SDK ships per-platform CLI binaries as optional deps (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, ~263 MB on darwin-arm64) and spawns one unless `options.pathToClaudeCodeExecutable` is set. Lattiz always passes the user's own installed `claude` (found through the login shell's PATH, because GUI apps on macOS don't inherit it), and doesn't ship the bundled binary (SPEC §6.5; app size). If `claude` isn't found the agent shows as Not installed with an install hint. SDK 0.3.N pairs with CLI 2.1.N; a newer user CLI has worked so far, but a mismatch is the first suspect if events stop parsing.
- **Auth.** Nothing to pass: the CLI uses its own sign-in (`apiKeySource: "none"` in `system/init` when it's a subscription login) or `ANTHROPIC_API_KEY` from the environment. Lattiz never reads `~/.claude*` credential files.
- `settingSources: []` isolates recordings from the user's settings; the adapter keeps the SDK default so users' own CLAUDE.md, hooks and permissions apply.

## Options used

| Option                   | Value                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `cwd`                    | chat cwd                                                                                                             |
| `model`                  | alias from `supportedModels()` (`default`, `opus`, `sonnet`, `haiku`, …)                                             |
| `effort`                 | `low`…`max` when the model `supportsEffort`                                                                          |
| `thinking`               | `{ type: "adaptive", display: "summarized" }` so thinking text is visible (default `omitted` streams empty thinking) |
| `includePartialMessages` | `true` (token streaming via `stream_event`)                                                                          |
| `permissionMode`         | see mapping below                                                                                                    |
| `canUseTool`             | permission / question / plan round-trips                                                                             |
| `resume`                 | `native_session_id` from a previous run                                                                              |

## Permission modes (SPEC §9.8)

| Lattiz              | SDK `permissionMode` | Notes                                                                               |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| Read-only           | `default`            | `canUseTool` auto-denies every non-read tool                                        |
| Ask                 | `default`            | Reads run without asking; edits and commands go through `canUseTool`                |
| Auto-edit (default) | `acceptEdits`        | Commands still go through `canUseTool`                                              |
| Full-auto           | `bypassPermissions`  | `canUseTool` is never called; the always-ask list runs as a PreToolUse hook (below) |

`canUseTool(toolName, input, { toolUseID, title, displayName, decisionReason, suggestions, signal })` resolves to `{ behavior: "allow", updatedInput, updatedPermissions? }` or `{ behavior: "deny", message, interrupt? }`.

- `suggestions` arrive with `destination: "localSettings"`, which would write into the repo's `.claude/settings.local.json`. For "Always for this chat" Lattiz rewrites them to `destination: "session"`.
- Reads (`Read`, `Glob`, `Grep`) are not asked in `default` mode.

## Always-ask list (probed live 2026-10-26, SDK 0.3.309, Haiku)

Every session registers `hooks.PreToolUse: [{ matcher: "Bash|PowerShell", timeout: 604800, hooks: [cb] }]`. The callback matches `tool_input.command` against the list (`matchAlwaysAsk`, `packages/shared/src/always-ask.ts`):

- No match, or a read-only chat: returns `{}` and the normal flow (mode, `canUseTool`) decides.
- Match: emits `permission.requested` with `alwaysAsk`, waits for the user, then returns `hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" | "deny", permissionDecisionReason }`.

Probed: in `bypassPermissions` a hook `deny` blocks the command and `allow` runs it, and the SDK waits for the callback (1.5 s in the probe). In `default` mode a hook `allow` skips `canUseTool`, so a listed command is asked about once, not twice. The SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` in bypass mode; that is expected. "Always" answers are treated as once. Recording: `always-ask-bypass.jsonl` (`record-claude-stream.mjs --mode bypassPermissions --deny-matching "rm -rf"`, `pre_tool_use` lines replayed by `replay.ts`).

## Questions and plans

- **AskUserQuestion:** comes through `canUseTool` with `input.questions[]` (`question`, `header`, `options[{label, description, preview?}]`, `multiSelect`). Answer with `allow` + `updatedInput: { ...input, answers: { [questionText]: "label" } }` (multi-select is comma-separated). Verified in `ask-question.jsonl`.
- **ExitPlanMode:** comes through `canUseTool` with `input.plan` (markdown). Approve with `allow`; "Keep planning" with `deny` + feedback message. Verified in `plan-mode.jsonl`. Plan mode writes its plan file under the user's `~/.claude/plans/` without asking.

## Message → AgentEvent mapping

| SDK message                                                                      | AgentEvent                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `system/init` (sent at the start of every turn)                                  | `session.started { nativeSessionId: session_id, model }`                                          |
| `stream_event` `content_block_delta/text_delta`                                  | `message.delta`                                                                                   |
| `stream_event` `content_block_delta/thinking_delta`                              | `thinking.delta`                                                                                  |
| `assistant` with `text` block                                                    | `message.completed` (authoritative full text)                                                     |
| `assistant` with `tool_use` block                                                | `tool.started { id, name, kind, input, paths }` (tool input deltas in `stream_event` are ignored) |
| `user` with `tool_result` block                                                  | `tool.completed { id, status: ok / error / denied }`                                              |
| `user.tool_use_result` with `structuredPatch` (Edit) or `type: "create"` (Write) | `file.changed { path, change, hunks, additions, deletions }`                                      |
| `canUseTool` (other tools)                                                       | `permission.requested`                                                                            |
| `canUseTool("AskUserQuestion")`                                                  | `question.asked`                                                                                  |
| `canUseTool("ExitPlanMode")`                                                     | `plan.proposed`                                                                                   |
| `rate_limit_event` with `status: "rejected"`                                     | `rate_limited { resetsAt, message }`                                                              |
| `result`                                                                         | `usage { inputTokens, outputTokens, costUsd }` then `turn.completed`                              |
| `parent_tool_use_id != null`                                                     | sets `parentId` on tool events (subagents)                                                        |

- `total_cost_usd` is cumulative across turns of one streaming session, so the adapter emits the per-turn delta. It's API-equivalent cost, not the subscription bill (SPEC §9.12 AC2).
- `system/status`, `system/thinking_tokens`, `system/commands_changed` and allowed `rate_limit_event`s are ignored for now (usage meter in M6).

## Interrupt and resume (probed live)

- `query.interrupt()` mid-stream returns `{ still_queued: [] }`; the turn ends with `result { subtype: "error_during_execution", is_error: true }`. The adapter maps this to `turn.completed { status: "interrupted" }` when it initiated the interrupt.
- `resume: <session_id>` in a fresh process continues the conversation with the same `session_id`. The model correctly recalled the interrupted turn.
- `resume` with an unknown id yields `result { subtype: "error_during_execution" }` without throwing. The adapter surfaces this as an error and clears the stored id.

## Model list

`query.supportedModels()` works before any user message is sent, so no tokens are spent. The recorded list starts with `default` ("Default (recommended)"), `opus` (Opus 5.5), `sonnet` (Sonnet 5.5) and `haiku`, each with `supportsEffort` / `supportedEffortLevels`.

## Packaging

The platform binary packages are excluded from the app (`!**/claude-agent-sdk-*/**` in electron-builder `files`). Only the SDK's JS ships.

## Steering (probed live 2026-10-23)

Pushing `{ type: "user", message, parent_tool_use_id: null, priority: "next" }` into the streaming input while a turn runs delivers it at the model's next step **without ending the turn**: one `result` for the whole turn, and the model followed the new instruction (ran `echo STEERED` instead of `echo second`). The CLI doesn't echo the steered message back in the stream, so Lattiz records it itself (`user.steered` event). The replay query skips `priority: "next"` messages.

## MCP servers and instructions (verified 2026-10-23, SDK 0.3.309, CLI 2.1.309)

- `Options.mcpServers` takes `{ [name]: { type: "http", url, headers } | { type: "stdio", command, args, env } }`. Tools show up as `mcp__<server>__<tool>`; Claude Code may load them lazily via `ToolSearch` first, which is visible as a step.
- MCP tool calls go through `canUseTool` like any other tool. Lattiz allows `mcp__lattiz__*` without asking (except in read-only chats).
- Long tool calls: the CLI's own MCP timeout is set with the `MCP_TOOL_TIMEOUT` env var (ms). Lattiz sets 30 minutes because `wait_for_chats` blocks.
- Instructions: `systemPrompt: { type: "preset", preset: "claude_code", append }` keeps Claude Code's own prompt and adds Lattiz's.
- Live S4 (`e2e/live-m5.spec.ts`): as the Conductor, Claude Code called `spawn_chat` ×3 (and chose `permission_mode: "read-only"` itself), then `wait_for_chats` and `create_note`, in a 47 s turn.

## Two ways to run Claude (2026-10-26)

Anthropic's Agent SDK docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." So Lattiz has two Claude agents:

| Agent       | id                | UI                                        | Auth                                                                                                                                                                                  |
| ----------- | ----------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | `claude-code`     | Lattiz's chat card (this SDK adapter)     | An Anthropic API key (Settings → Agents, keychain) or `ANTHROPIC_API_KEY` from the shell. The user's sign-in only in dev runs and personal builds (`LATTIZ_PERSONAL=1 pnpm package`). |
| Claude Code | `terminal:claude` | Claude Code's own terminal UI in the tile | The user's own Claude Code sign-in, untouched by Lattiz                                                                                                                               |

Verified 2026-10-26 (CLI 2.1.310): with `ANTHROPIC_API_KEY` in the env, the SDK session uses only the key. `accountInfo()` reports `apiKeySource: "ANTHROPIC_API_KEY"`, and a bad key fails with "Invalid API key" rather than falling back to the subscription.

## Terminal (`terminal:claude`, probed live 2026-10-26)

Lattiz starts `claude --session-id <uuid> --settings <file>` in a PTY. After a restart it uses `--resume <uuid>`. With workspace tools it adds `--mcp-config <file>`, and with instructions `--append-system-prompt`. The files go in `<dataDir>/run`, mode 0600 (they hold tokens), and are removed when the session ends. The settings file adds HTTP hooks (`type: "http"`, `Authorization: Bearer <per-chat hook token>`) for `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Notification` and `Stop`. They POST to `/hooks` on Lattiz's loopback server, next to `/mcp`, with separate tokens. The user's own hooks keep running.

| Hook                           | Lattiz                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`             | Records a turn and takes its checkpoint before answering, so Review and the timeline work. Text Lattiz typed itself (queue, flows) doesn't start a second turn.                                                                                                               |
| `PreToolUse` (Bash/PowerShell) | Always-ask list. A match is held, and shown as a banner over the terminal and in the Inbox. The answer comes back as `permissionDecision`.                                                                                                                                    |
| `PermissionRequest`            | Claude Code shows its own prompt **and** Lattiz raises an Inbox item. Whichever answers first wins. When the terminal answers, Claude abandons the HTTP request and the next hook settles Lattiz's item. "Always" maps to `updatedPermissions` with `destination: "session"`. |
| `PostToolUse`                  | Working.                                                                                                                                                                                                                                                                      |
| `Notification`                 | `idle_prompt` means idle when no turn is open. Other types (not `permission_prompt`) mean needs-you.                                                                                                                                                                          |
| `Stop`                         | `last_assistant_message` becomes the finished summary, then `turn.completed`.                                                                                                                                                                                                 |

- **Not observed:** `SessionStart` didn't reach an HTTP hook in the probes. Lattiz passes `--session-id` instead, so it knows the id up front.
- **Interrupts:** Esc or Ctrl+C mid-turn with no hook within 2.5 s counts as an interrupt, because Claude Code doesn't run `Stop` on an interrupt.
- **Trust prompt:** a new folder still shows Claude Code's own "trust this folder" prompt, which the user answers in the terminal.
- **Tests:**
  - `fixtures/terminal/fake-claude/claude` speaks the same hook protocol for `e2e/claude-terminal.spec.ts`.
  - `e2e/live-claude-terminal.spec.ts` (`LATTIZ_LIVE=1`) runs the real CLI.
  - Windows is unverified: Claude Code runs hooks itself, but `--settings` paths there aren't tested.
