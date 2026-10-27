import { z } from "zod";

// Normalised agent event schema (SPEC §6.2). Every adapter maps its native
// stream onto this union; the EventLog stores it verbatim.

export const ToolKind = z.enum(["read", "edit", "exec", "search", "web", "mcp", "subagent", "other"]);
export type ToolKind = z.infer<typeof ToolKind>;

export const DiffHunk = z.object({
  oldStart: z.number().int(),
  oldLines: z.number().int(),
  newStart: z.number().int(),
  newLines: z.number().int(),
  /** Unified diff lines, each prefixed with " ", "+", "-" or "\\". */
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunk>;

export const QuestionSpec = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
});
export type QuestionSpec = z.infer<typeof QuestionSpec>;

/** One usage window of an agent account (§9.12), e.g. Claude's 5-hour window or Codex's weekly one. */
export const UsageWindow = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().optional(),
  resetsAt: z.string().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

export const AgentEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.started"), nativeSessionId: z.string().optional(), model: z.string() }),
  z.object({ type: z.literal("message.delta"), text: z.string() }),
  z.object({ type: z.literal("message.completed"), text: z.string() }),
  z.object({ type: z.literal("thinking.delta"), text: z.string() }),
  z.object({
    type: z.literal("tool.started"),
    id: z.string(),
    kind: ToolKind,
    name: z.string(),
    input: z.unknown(),
    paths: z.array(z.string()).optional(),
    parentId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool.completed"),
    id: z.string(),
    status: z.enum(["ok", "error", "denied"]),
    output: z.unknown().optional(),
  }),
  z.object({
    type: z.literal("file.changed"),
    path: z.string(),
    change: z.enum(["created", "modified", "deleted"]),
    // Lattiz extension: unified-diff hunks when the agent reports them (inline diffs, §8.5).
    hunks: z.array(DiffHunk).optional(),
    additions: z.number().int().optional(),
    deletions: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("permission.requested"),
    id: z.string(),
    kind: ToolKind,
    summary: z.string(),
    command: z.string().optional(),
    paths: z.array(z.string()).optional(),
    reason: z.string().optional(),
    // Lattiz extension: the always-ask pattern this matched (§9.8 AC3). Only "allow once" is offered.
    alwaysAsk: z.string().optional(),
  }),
  z.object({
    type: z.literal("question.asked"),
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    // Lattiz extension: agents like Claude Code ask several structured questions at once.
    questions: z.array(QuestionSpec).optional(),
  }),
  z.object({ type: z.literal("plan.proposed"), id: z.string(), markdown: z.string() }),
  z.object({ type: z.literal("subagent.started"), id: z.string(), parentToolId: z.string(), prompt: z.string() }),
  z.object({ type: z.literal("subagent.completed"), id: z.string(), report: z.string() }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  z.object({ type: z.literal("rate_limited"), resetsAt: z.string().optional(), message: z.string() }),
  // Lattiz extension: the account's usage windows as the agent reports them (§9.12). Not stored in transcripts.
  z.object({ type: z.literal("usage.window"), windows: z.array(UsageWindow) }),
  z.object({
    type: z.literal("turn.completed"),
    status: z.enum(["ok", "interrupted", "error"]),
    durationMs: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string(), recoverable: z.boolean() }),
  // Lattiz extension: a message the user sent into a running turn (§9.9). Agents don't echo steers back.
  z.object({ type: z.literal("user.steered"), text: z.string() }),
  // Lattiz extension: state inferred from a terminal-only agent's output (§6.3); `detail` is the line that triggered it.
  z.object({ type: z.literal("agent.status"), status: z.enum(["working", "idle", "needs-you"]), detail: z.string().optional() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent["type"];

/** An event as persisted in the EventLog (SPEC §7.1 `events`). */
export const StoredEvent = z.object({
  chatId: z.string(),
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  turnId: z.string().nullable(),
  event: AgentEvent,
});
export type StoredEvent = z.infer<typeof StoredEvent>;

export const ChatStatus = z.enum(["idle", "working", "needs-you", "done", "error"]);
export type ChatStatus = z.infer<typeof ChatStatus>;

/** Status transition driven by a single event. Returns `prev` when the event doesn't change state. */
export function nextStatus(prev: ChatStatus, e: AgentEvent): ChatStatus {
  switch (e.type) {
    case "permission.requested":
    case "question.asked":
    case "plan.proposed":
    case "rate_limited":
      return "needs-you";
    case "turn.completed":
      return e.status === "error" ? "error" : "done";
    case "error":
      return e.recoverable ? prev : "error";
    case "agent.status":
      return e.status === "idle" ? "done" : e.status;
    case "session.started":
    case "usage":
    case "usage.window":
      return prev;
    default:
      return "working";
  }
}

/**
 * Coalesce a batch of events for delivery to the renderer (SPEC §5.2):
 * consecutive message/thinking deltas are concatenated into one event.
 */
export function coalesceEvents(events: StoredEvent[]): StoredEvent[] {
  const out: StoredEvent[] = [];
  for (const se of events) {
    const last = out[out.length - 1];
    if (
      last &&
      last.chatId === se.chatId &&
      last.turnId === se.turnId &&
      (se.event.type === "message.delta" || se.event.type === "thinking.delta") &&
      last.event.type === se.event.type
    ) {
      out[out.length - 1] = {
        ...se,
        event: { type: se.event.type, text: last.event.text + se.event.text },
      };
    } else {
      out.push(se);
    }
  }
  return out;
}
