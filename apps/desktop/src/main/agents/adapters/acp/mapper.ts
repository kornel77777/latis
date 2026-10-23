import { isAbsolute, relative } from "node:path";
import { structuredPatch } from "diff";
import { countChanges, type AgentEvent, type DiffHunk, type ToolKind } from "@latis/shared";

// ACP `session/update` notifications → AgentEvents (docs/adapters/acp.md).

interface ContentBlock {
  type: string;
  text?: string;
}
type ToolContent =
  | { type: "diff"; path: string; oldText: string | null; newText: string; _meta?: { kind?: string } }
  | { type: "content"; content: ContentBlock }
  | { type: "terminal"; terminalId: string };

export interface ToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: ToolContent[] | null;
  locations?: { path: string; line?: number }[] | null;
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: ContentBlock }
  | ({ sessionUpdate: "tool_call" } & ToolCall)
  | ({ sessionUpdate: "tool_call_update" } & ToolCall)
  | { sessionUpdate: "usage_update"; used?: number; size?: number; cost?: { amount: number; currency: string } | null }
  | { sessionUpdate: string };

const KINDS: Record<string, ToolKind> = {
  read: "read",
  edit: "edit",
  delete: "edit",
  move: "edit",
  search: "search",
  execute: "exec",
  fetch: "web",
  think: "other",
  switch_mode: "other",
  other: "other",
};
/** Placeholder titles agents send before the real input has streamed in. */
const PLACEHOLDER = /^(Terminal|Preparing file…|Preparing.*|Running.*)$/;

interface Tool {
  call: ToolCall;
  started: boolean;
  done: boolean;
  diffs: Map<string, { oldText: string | null; newText: string; created: boolean }>;
}

export function diffHunks(oldText: string | null, newText: string): DiffHunk[] {
  const patch = structuredPatch("a", "b", oldText ?? "", newText, undefined, undefined, { context: 3 });
  // jsdiff numbers an empty side from 1; unified diffs (and git) use 0.
  return patch.hunks.map((h) => ({
    oldStart: h.oldLines === 0 ? h.oldStart - 1 : h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newLines === 0 ? h.newStart - 1 : h.newStart,
    newLines: h.newLines,
    lines: h.lines,
  }));
}

export class AcpMapper {
  private tools = new Map<string, Tool>();
  private message = "";
  private cost = 0;

  constructor(private readonly cwd: string) {}

  private rel(p: string): string {
    if (!isAbsolute(p)) return p;
    const r = relative(this.cwd, p);
    return r.startsWith("..") ? p : r;
  }

  /** The assistant text streamed since the last tool call or turn end. */
  private flushMessage(): AgentEvent[] {
    if (!this.message) return [];
    const text = this.message;
    this.message = "";
    return [{ type: "message.completed", text }];
  }

  private paths(call: ToolCall): string[] {
    const fromLocations = (call.locations ?? []).map((l) => this.rel(l.path));
    const fromDiffs = (call.content ?? []).flatMap((c) => (c.type === "diff" ? [this.rel(c.path)] : []));
    return [...new Set([...fromLocations, ...fromDiffs])];
  }

  private input(call: ToolCall): unknown {
    const raw = call.rawInput;
    const empty = raw === undefined || raw === null || (typeof raw === "object" && Object.keys(raw).length === 0);
    if (!empty) return raw;
    return call.title ? { title: call.title } : {};
  }

  private start(tool: Tool): AgentEvent[] {
    if (tool.started) return [];
    tool.started = true;
    const c = tool.call;
    const name = c.title && !PLACEHOLDER.test(c.title) ? c.title : (c.kind ?? "tool");
    const paths = this.paths(c);
    return [
      ...this.flushMessage(),
      {
        type: "tool.started",
        id: c.toolCallId,
        kind: KINDS[c.kind ?? "other"] ?? "other",
        name,
        input: this.input(c),
        ...(paths.length && { paths }),
      },
    ];
  }

  /** Whether the call carries enough to show (real input, a final status, or content). */
  private ready(call: ToolCall): boolean {
    const raw = call.rawInput;
    const hasInput = raw !== undefined && raw !== null && !(typeof raw === "object" && Object.keys(raw).length === 0);
    return hasInput || call.status === "completed" || call.status === "failed" || Boolean(call.content?.length);
  }

  private merge(tool: Tool, update: ToolCall) {
    const call = tool.call;
    for (const [k, v] of Object.entries(update)) if (v !== undefined && v !== null) (call as unknown as Record<string, unknown>)[k] = v;
    // New files: oldText null (Claude bridge) or "" with _meta.kind "add" (Gemini CLI).
    for (const c of update.content ?? [])
      if (c.type === "diff") {
        // Later updates repeat the diff without _meta; once created, it stays created.
        const created = tool.diffs.get(c.path)?.created || c.oldText === null || c._meta?.kind === "add";
        tool.diffs.set(c.path, { oldText: c.oldText, newText: c.newText, created });
      }
  }

  private complete(tool: Tool): AgentEvent[] {
    if (tool.done) return [];
    tool.done = true;
    const c = tool.call;
    // How agents word a refusal: the Claude bridge "User refused permission", Gemini "was canceled by the user".
    const said = JSON.stringify([c.rawOutput ?? "", c.content ?? []]);
    const status = c.status === "failed" ? (/refused|denied|rejected|cancell?ed by the user/i.test(said) ? "denied" : "error") : "ok";
    const files: AgentEvent[] =
      status === "ok"
        ? [...tool.diffs].map(([path, d]) => {
            const hunks = diffHunks(d.oldText, d.newText);
            return {
              type: "file.changed",
              path: this.rel(path),
              change: d.created ? "created" : "modified",
              hunks,
              ...countChanges(hunks),
            };
          })
        : [];
    const output =
      c.rawOutput ?? (c.content ?? []).flatMap((x) => (x.type === "content" && x.content.text ? [x.content.text] : [])).join("\n");
    return [...files, { type: "tool.completed", id: c.toolCallId, status, ...(output !== "" && { output }) }];
  }

  update(u: SessionUpdate): AgentEvent[] {
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = (u as { content: ContentBlock }).content.text ?? "";
        this.message += text;
        return text ? [{ type: "message.delta", text }] : [];
      }
      case "agent_thought_chunk": {
        const text = (u as { content: ContentBlock }).content.text ?? "";
        return text ? [{ type: "thinking.delta", text }] : [];
      }
      case "tool_call":
      case "tool_call_update": {
        const call = u as ToolCall;
        let tool = this.tools.get(call.toolCallId);
        if (!tool) {
          tool = { call: { toolCallId: call.toolCallId }, started: false, done: false, diffs: new Map() };
          this.tools.set(call.toolCallId, tool);
        }
        this.merge(tool, call);
        const out: AgentEvent[] = [];
        if (this.ready(tool.call)) out.push(...this.start(tool));
        if (tool.started && (tool.call.status === "completed" || tool.call.status === "failed")) out.push(...this.complete(tool));
        return out;
      }
      case "usage_update": {
        const cost = (u as { cost?: { amount: number; currency: string } | null }).cost;
        if (cost?.currency === "USD") this.cost = cost.amount;
        return [];
      }
      default:
        return [];
    }
  }

  /** The permission request for a tool call (starting the step first if it hasn't shown yet). */
  permission(requestId: string, call: ToolCall): AgentEvent[] {
    let tool = this.tools.get(call.toolCallId);
    if (!tool) {
      tool = { call: { toolCallId: call.toolCallId }, started: false, done: false, diffs: new Map() };
      this.tools.set(call.toolCallId, tool);
    }
    this.merge(tool, call);
    const c = tool.call;
    const kind = KINDS[c.kind ?? "other"] ?? "other";
    const raw = (c.rawInput ?? {}) as { command?: unknown };
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const paths = this.paths(c);
    return [
      ...this.start(tool),
      {
        type: "permission.requested",
        id: requestId,
        kind,
        summary: c.title && !PLACEHOLDER.test(c.title) ? c.title : "Use a tool",
        ...(command !== undefined && { command }),
        ...(paths.length && { paths }),
      },
    ];
  }

  markDenied(toolCallId: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool) tool.call.rawOutput = "denied";
  }

  /** Closes the turn: pending text, unfinished steps, cost, and the turn itself. */
  turnEnd(stopReason: string, durationMs: number, usage?: { inputTokens?: number; outputTokens?: number }): AgentEvent[] {
    const out = this.flushMessage();
    for (const tool of this.tools.values()) {
      if (tool.started && !tool.done) {
        tool.done = true;
        out.push({ type: "tool.completed", id: tool.call.toolCallId, status: "error", output: "Stopped" });
      }
    }
    this.tools.clear();
    if (usage || this.cost) {
      out.push({
        type: "usage",
        ...(usage?.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
        ...(usage?.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
        ...(this.cost && { costUsd: this.cost }),
      });
    }
    this.cost = 0;
    const status = stopReason === "cancelled" ? "interrupted" : stopReason === "refusal" ? "error" : "ok";
    out.push({ type: "turn.completed", status, durationMs });
    return out;
  }
}
