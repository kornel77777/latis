# ACP adapter (Gemini CLI + generic manifests): verified integration notes

Verified 2026-10-23 against the Agent Client Protocol v1 as implemented by `@agentclientprotocol/sdk@2.0.1` (method list) and two real agents:

- **Gemini CLI `0.65.0`** (`gemini --acp`; `--experimental-acp` is deprecated): `initialize` verified. Not signed in on the dev machine, so no prompt stream was recorded yet. `session/new` fails with JSON-RPC error `-32000 "Gemini API key is missing or not configured."` when signed out.
- **`@agentclientprotocol/claude-agent-acp@0.94.0`** (Claude Code over ACP, using the existing Claude sign-in): full recordings in `fixtures/acp/`. It stands in for "any ACP agent" in tests. Recorder: `apps/desktop/scripts/record-acp-stream.mjs --agent "<cmd args>"`.

Re-record Gemini once it's signed in: `node scripts/record-acp-stream.mjs gemini-write-run "<prompt>" --agent "gemini --acp"`.

## Wire format

Newline-delimited JSON-RPC 2.0 over stdio (`"jsonrpc": "2.0"` on every frame). Agents may log to stderr. The adapter ignores non-JSON stdout lines.

## Client → agent

| Method                      | Use                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                | `{ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo }` → `{ protocolVersion, agentCapabilities: { loadSession, promptCapabilities, … }, authMethods[], agentInfo }` |
| `session/new`               | `{ cwd, mcpServers: [] }` → `{ sessionId, modes?: { currentModeId, availableModes[] }, configOptions?: [] }`                                                                                                                                  |
| `session/load`              | `{ sessionId, cwd, mcpServers }` when `agentCapabilities.loadSession`. The agent **replays the whole history** as `session/update` notifications before responding                                                                            |
| `session/prompt`            | `{ sessionId, prompt: [{ type: "text", text }] }` → `{ stopReason: end_turn \| max_tokens \| max_turn_requests \| refusal \| cancelled, usage? }` after the turn                                                                              |
| `session/cancel`            | notification `{ sessionId }`; the pending `session/prompt` resolves with `stopReason: "cancelled"`                                                                                                                                            |
| `session/set_mode`          | `{ sessionId, modeId }`                                                                                                                                                                                                                       |
| `session/set_config_option` | `{ sessionId, configId, value }` → `{ configOptions }` (models, effort)                                                                                                                                                                       |

Latis declares no `fs` or `terminal` client capabilities, so agents use their own tools on disk and Latis only observes. That keeps behaviour identical to running the agent in a terminal.

## Agent → client

- `session/request_permission { sessionId, toolCall, options[{ optionId, name, kind: allow_once | allow_always | reject_once | reject_always }] }` → `{ outcome: { outcome: "selected", optionId } | { outcome: "cancelled" } }`. Latis picks the option whose `kind` matches the user's choice. The option ids are agent-specific (`allow-once`, `reject` from the Claude bridge).
- `session/update { sessionId, update }` notifications:

| `update.sessionUpdate`                                                     | AgentEvent                                                                                                                          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk { content.text }`                                     | `message.delta`. There's no "message completed" frame, so the adapter emits `message.completed` when a tool starts or the turn ends |
| `agent_thought_chunk`                                                      | `thinking.delta`                                                                                                                    |
| `tool_call { toolCallId, title, kind, status, rawInput, locations }`       | `tool.started`. `kind` read/edit/delete/move/search/execute/think/fetch/other maps onto ToolKind                                    |
| `tool_call_update { status: completed / failed }`                          | `tool.completed` (ok / error). The Claude bridge reports a refusal as `failed` with "User refused permission"                       |
| `tool_call_update { content: [{ type: "diff", path, oldText, newText }] }` | stored. On completion it becomes `file.changed` with hunks computed by Latis                                                        |
| `plan { entries[] }`                                                       | ignored for now (a todo list, not an approvable plan)                                                                               |
| `usage_update { used, size, cost? }`                                       | `cost.amount` gives a per-turn `usage.costUsd` when present                                                                         |
| `user_message_chunk`                                                       | only seen during `session/load` replay. Ignored                                                                                     |
| `current_mode_update`, `config_option_update`, `available_commands_update` | update cached modes/options                                                                                                         |

- `tool_call` arrives first with empty `rawInput` and `title: "Terminal"` / "Preparing file…". The real input lands in later `tool_call_update`s, so the adapter emits `tool.started` lazily, once input or a terminal status arrives.
- Updates with names starting `_` (`_auth/status_update` from the Claude bridge) are extension notifications. They're ignored but tell us the agent is signed in.

## Permission modes

ACP has no standard permission vocabulary. A manifest can map Latis modes onto the agent's own `modes` ids:

```json
"modes": { "read-only": "plan", "ask": "default", "auto-edit": "autoEdit", "full-auto": "yolo" }
```

(Gemini's mode ids match its `--approval-mode` choices `default`, `auto_edit`, `yolo`, `plan`. Read them from `session/new` once signed in; the built-in manifest maps by name match against `availableModes`.) Without a mapping, Latis **emulates** modes on `session/request_permission`: read-only rejects everything not `kind: read/search`, auto-edit auto-allows `kind: edit`, full-auto allows everything. The always-ask list can't be enforced (the agent decides what to ask about).

## Steering

Not in ACP v1. The Claude bridge advertises `_meta.steering.supported` / `promptQueueing`, but generic ACP agents get the fallback from SPEC §9.9 AC2: queued messages are sent when the turn ends.

## Fixtures (`fixtures/acp/`, recorded through the Claude bridge with Haiku)

| File              | What it shows                                                                   |
| ----------------- | ------------------------------------------------------------------------------- |
| `write-run.jsonl` | Write with permission (diff content), then a shell command run without asking   |
| `deny.jsonl`      | Shell write rejected → `tool_call_update failed`, model explains                |
| `cancel.jsonl`    | `session/cancel` mid-turn → `stopReason: "cancelled"`                           |
| `resume.jsonl`    | Process restart + `session/load` (history replay), the model recalls a codeword |

## Gemini built-in

- Command `gemini --acp`. Detect with `gemini --version`. Install hint `npm install -g @google/gemini-cli`.
- Auth methods from `initialize`: `oauth-personal` (Log in with Google), `gemini-api-key`, `vertex-ai`, `gateway`. Sign-in runs plain `gemini` in a PTY (its first-run auth picker). Latis never reads `~/.gemini` credential files.
- `session/new` failing with an auth error → the agent shows **Signed out** with a Sign in action.
