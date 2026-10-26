# ACP adapter (Gemini CLI + generic manifests): verified integration notes

Verified 2026-10-23 against the Agent Client Protocol v1 as implemented by `@agentclientprotocol/sdk@2.0.1` (method list) and two real agents:

- **Gemini CLI `0.65.0`** (`gemini --acp`; `--experimental-acp` is deprecated): signed in with Google (2026-10-23), recorded in `fixtures/acp/gemini-*.jsonl` with `gemini-3.5-flash-lite`. When signed out, `session/new` fails with JSON-RPC error `-32000 "Gemini API key is missing or not configured."`.
- **`@agentclientprotocol/claude-agent-acp@0.94.0`** (Claude Code over ACP, using the existing Claude sign-in): full recordings in `fixtures/acp/`. It stands in for "any ACP agent" in tests. Recorder: `apps/desktop/scripts/record-acp-stream.mjs --agent "<cmd args>"`.

Re-record Gemini: `node scripts/record-acp-stream.mjs gemini-write-run "<prompt>" --agent "gemini --acp" --model gemini-3.5-flash-lite`.

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

(Gemini's mode ids match its `--approval-mode` choices `default`, `auto_edit`, `yolo`, `plan`. Read them from `session/new` once signed in; the built-in manifest maps by name match against `availableModes`.) Without a mapping, Latis **emulates** modes on `session/request_permission`: read-only rejects everything not `kind: read/search`, auto-edit auto-allows `kind: edit`, full-auto allows everything.

**Always-ask list:** a `kind: "execute"` request whose command (`rawInput.command`, else the title, which is Gemini's command line) matches the list goes to the user in every mode except Read-only, and "always" answers aren't remembered. In Full-auto with a non-empty list the agent runs in its auto-edit mode instead of yolo, so it asks before commands and Latis allows the unlisted ones. This only covers commands the agent asks about: Gemini runs commands it considers safe (e.g. `wc -l`) without asking. So ACP agents keep the Full-auto warning in the chat header. Tested by replay with `deny.jsonl` (Claude bridge); Gemini not yet recorded live (free quota).

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

## Gemini specifics (recorded 2026-10-23)

- **Modes:** `default` (asks), `autoEdit`, `yolo`, `plan` (read-only). In a folder Gemini doesn't trust yet, `session/set_mode` to `autoEdit` or `yolo` fails with `-32603 "Cannot enable privileged approval modes in an untrusted folder."`. Choosing an `allow_always` permission option fails the tool the same way. So Latis:
  - treats a refused mode switch as non-fatal and enforces the mode itself in `session/request_permission`;
  - answers "Always for this chat" with `allow_once`, remembering the decision per tool kind (per program name for shell commands).
- **Models:** no `configOptions`. `session/new` returns the older `models: { availableModels[{modelId, name}], currentModelId: "auto" }`. Switching uses `session/set_model { sessionId, modelId }`; `session/set_config_option` is "Method not found".
- **New files:** the diff content has `oldText: ""` with `_meta.kind: "add"` (not `oldText: null`).
- **Rejections:** a rejected tool comes back `failed` with text `Tool "write_file" was canceled by the user.`.
- **Shell tools:** `kind: execute`, `title` is the command, `content` is text like `[current working directory …] (description)`. There's no `rawInput`.
- **Thoughts:** streamed as `agent_thought_chunk` with a bold title line.
- **Process tree:** `gemini` re-launches itself as a child `node --max-old-space-size=…` process. Killing only the wrapper leaves the child running, so Latis starts agents in their own process group and kills the group (`taskkill /T` on Windows).
- **Resume:** `session/load` replays a `<session_context>` user chunk and the history before responding; Latis drops them.

## MCP servers (verified 2026-10-23, Gemini CLI 0.65)

- `session/new` and `session/load` take `mcpServers`. Every agent must accept stdio entries `{ name, command, args, env: [{ name, value }] }`. HTTP entries `{ type: "http", name, url, headers: [{ name, value }] }` are allowed only when `initialize` returns `agentCapabilities.mcpCapabilities.http`. Gemini 0.65 reports `{ http: true, sse: true }`.
- Latis gives ACP agents its own server through the stdio shim `latis-mcp`, so any ACP agent works. Other HTTP connections are passed only to agents that advertise `http`.
- ACP has no system prompt. The Conductor's instructions go in front of the first message of a new session, inside `<instructions>`.
- Permission requests for Latis's tools (title `… (latis MCP Server)`) are allowed by Latis, except in read-only chats.
- **Quota:** when the Gemini free tier is out of daily requests (429), `gemini --acp` keeps retrying and sends nothing, so the turn looks like it's working indefinitely. `gemini -p` shows the 429. Gemini calling the workspace tools through the shim is not verified live yet: the quota ran out during M5. The shim itself is covered by the e2e Conductor test.
- Live S4: a Gemini chat spawned by the Conductor reviewed the auth module in 9 s.
