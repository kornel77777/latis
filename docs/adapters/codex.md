# Codex adapter: verified integration notes

Verified 2026-10-23 against `@openai/codex@0.163.0` (`codex-cli 0.163.0`, macOS arm64, ChatGPT Plus sign-in) using bindings from `codex app-server generate-ts` and real recorded exchanges in `fixtures/codex/`. Re-verify when the user's Codex changes minor version (SPEC §0.2). Recorder: `apps/desktop/scripts/record-codex-stream.mjs`.

## Integration

- `codex app-server` (no flags) speaks newline-delimited JSON-RPC over stdio. Frames have **no `"jsonrpc"` field**. Requests are `{id, method, params}`, responses `{id, result | error}`, notifications `{method, params}`.
- Server→client requests (approvals, questions) use their **own id space**, starting at 0, so a response id and a server-request id can collide. Tell them apart by the presence of `method`.
- **Handshake:** `initialize { clientInfo: {name, title, version}, capabilities: null }`, then the `initialized` notification. The response carries `codexHome`, `platformOs` and the user agent.
- **Executable:** the user's own `codex`, found via the login-shell PATH (same as Claude Code). The npm package ships a native binary per platform. Latis bundles nothing.
- **Auth:** handled entirely by Codex. `account/read { refreshToken: false }` returns `{ account: { type: "chatgpt", planType } | { type: "apiKey" } | null, requiresOpenaiAuth }` and spends no tokens. Latis never reads `~/.codex/auth.json`. `codex login status` gives the same answer in a terminal. Sign-in runs `codex login` in a PTY.
- The user's `~/.codex/config.toml` applies: MCP servers, hooks and instructions load as they would in the CLI. Some recordings show the user's MCP servers starting (`mcpServer/startupStatus/updated`), which the adapter ignores.

## Lifecycle

| Step       | Request                                                                                                                                  | Notes                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New chat   | `thread/start { cwd, model?, approvalPolicy, sandbox }` → `{ thread: { id }, model, reasoningEffort }`                                   | `thread.id` is the native session id                                                                                                                                            |
| Resume     | `thread/resume { threadId, cwd, approvalPolicy, sandbox, excludeTurns: true }`                                                           | Works in a fresh server process; recalled earlier context in `resume.jsonl`                                                                                                     |
| Send       | `turn/start { threadId, input: [{type:"text", text, text_elements: []}], model?, effort? }` → `{ turn }`                                 | `model` / `effort` overrides stick for later turns                                                                                                                              |
| Steer      | `turn/steer { threadId, expectedTurnId, input }` → `{ turnId }`                                                                          | Delivered at the model's next step without stopping the turn. Verified in `steer.jsonl` (fruits → vegetables). Fails with `activeTurnNotSteerable` for some turn kinds (review) |
| Interrupt  | `turn/interrupt { threadId, turnId }` → `{}`                                                                                             | `turn/completed` follows with `status: "interrupted"`. Running items get **no** `item/completed`, so the adapter closes open steps itself                                       |
| Models     | `model/list {}` → `{ data: [{ id, displayName, description, supportedReasoningEfforts[], defaultReasoningEffort, isDefault, hidden }] }` | No tokens spent. Efforts seen: low, medium, high, xhigh, max, ultra                                                                                                             |
| Rate limit | `account/rateLimits/read` and `account/rateLimits/updated` notifications                                                                 | `primary`/`secondary` windows with `usedPercent`, `resetsAt`. Kept for the usage meter (M6)                                                                                     |

## Permission modes (SPEC §9.8)

| Latis               | `sandbox`            | `approvalPolicy` | Latis-side behaviour                                                                                  |
| ------------------- | -------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Read-only           | `read-only`          | `never`          | Writes fail in the sandbox, nothing asks                                                              |
| Ask                 | `workspace-write`    | `untrusted`      | Pure reads (see below) auto-accepted; every other command and every patch goes to the user            |
| Auto-edit (default) | `workspace-write`    | `untrusted`      | Patches whose paths are all inside the chat cwd and pure reads are auto-accepted; commands go to user |
| Full-auto           | `danger-full-access` | `never`          | Nothing asks; the always-ask list can't be enforced (chat header warns)                               |

- Recorded: with `untrusted`, Codex asks before **every** `apply_patch`, even inside the workspace, and before plain reads like `cat README.md`. Without the Latis-side auto-accept, Auto-edit would behave like Ask.
- A "pure read" is a command approval whose `commandActions` are all `read`, `listFiles` or `search` (Codex's own parse of the command).
- Mode changes take effect on the next `turn/start` (`approvalPolicy` and `sandboxPolicy` are per-turn overrides). `sandboxPolicy` takes the object form: `{type:"readOnly", networkAccess}`, `{type:"workspaceWrite", writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}` or `{type:"dangerFullAccess"}` (all fields required).

### Approval requests (server → client)

| Method                                  | Params used                                                                      | Response                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `item/commandExecution/requestApproval` | `itemId`, `command`, `cwd`, `reason`, `commandActions`                           | `{ decision: "accept" \| "acceptForSession" \| "decline" \| "cancel" }`  |
| `item/fileChange/requestApproval`       | `itemId` (the `fileChange` item that started just before), `reason`, `grantRoot` | same decisions                                                           |
| `item/tool/requestUserInput`            | `questions[{ id, header, question, options[{label, description}] }]`             | `{ answers: { [questionId]: { answers: [label] } } }` (not yet recorded) |
| `item/permissions/requestApproval`      | extra sandbox permissions                                                        | `{ permissions, scope }`. Not handled: declined with an error            |

- "Always for this chat" maps to `acceptForSession`. `decline` lets the model continue and explain. `cancel` ends the turn.
- `serverRequest/resolved { requestId }` follows every answer.

## Notification → AgentEvent mapping

| Notification                                                                                         | AgentEvent                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `thread/start` response / `thread/started`                                                           | `session.started { nativeSessionId: thread.id, model }`                                                                   |
| `item/agentMessage/delta { itemId, delta }`                                                          | `message.delta`                                                                                                           |
| `item/completed { agentMessage }`                                                                    | `message.completed` (both `phase: "commentary"` and `"final_answer"`)                                                     |
| `item/reasoning/summaryTextDelta`                                                                    | `thinking.delta` (raw `reasoning/textDelta` is ignored)                                                                   |
| `item/started { commandExecution }`                                                                  | `tool.started { kind: exec, name: "Shell", input: { command } }`. The `/bin/zsh -lc '…'` wrapper is unwrapped for display |
| `item/completed { commandExecution }`                                                                | `tool.completed`: `completed` → ok, `failed` → error, `declined` → denied, output `aggregatedOutput`                      |
| `item/started { fileChange }`                                                                        | `tool.started { kind: edit, name: "Patch", paths }`                                                                       |
| `item/completed { fileChange, status: completed }`                                                   | `file.changed` per change (unified `diff` parsed into hunks), then `tool.completed`                                       |
| `item/started { mcpToolCall }` / `{ webSearch }` / `{ dynamicToolCall }`                             | `tool.started { kind: mcp / web / other }`                                                                                |
| `item/started { collabAgentToolCall }`                                                               | `tool.started { kind: subagent }`                                                                                         |
| `turn/plan/updated { plan[] }`                                                                       | ignored for now (Codex's own todo list, not a plan to approve)                                                            |
| `thread/tokenUsage/updated { tokenUsage.last }`                                                      | accumulated; `usage { inputTokens, outputTokens }` on turn end. No cost: Codex doesn't report one                         |
| `error { error: { codexErrorInfo: "usageLimitExceeded" \| "rateLimitExceeded" }, willRetry: false }` | `rate_limited`                                                                                                            |
| `error { willRetry: false }` (other)                                                                 | `error { recoverable: true }`                                                                                             |
| `turn/completed { turn.status: completed / interrupted / failed }`                                   | `turn.completed { ok / interrupted / error }`                                                                             |

- `userMessage` items echo the prompt and are ignored. `item/fileChange/outputDelta`, `turn/diff/updated`, `rawResponseItem/*`, `thread/status/changed` and MCP startup events are ignored.
- Item ids for messages are opaque (`msg_…`), command ids look like `exec-<uuid>`. A `fileChange` id can also look like `exec-<uuid>`.

## Fixtures

| File                  | What it shows                                                                    |
| --------------------- | -------------------------------------------------------------------------------- |
| `write-and-run.jsonl` | Auto-edit: one shell command (writes a file, `wc -l`), command approval accepted |
| `edit-file.jsonl`     | `cat` approval, then `apply_patch` with a file-change approval and diff          |
| `deny-write.jsonl`    | Command approval declined, model explains                                        |
| `steer.jsonl`         | `turn/steer` mid-turn changes the task                                           |
| `interrupt.jsonl`     | `turn/interrupt` during a running command                                        |
| `resume.jsonl`        | Server restart + `thread/resume`, the model recalls a codeword                   |

Ids are scrubbed to `<idN>` placeholders (consistent within a file, and thread ids come out as `<id2>` in every file), paths to `<cwd>` / `<home>`, emails to `user@example.com`.
