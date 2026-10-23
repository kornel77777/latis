import { isAbsolute, relative } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, DiffHunk, QuestionSpec, ToolKind } from "@latis/shared";

// Maps Claude Agent SDK messages onto the normalised AgentEvent schema.
// Verified against fixtures/claude-code/*.jsonl; see docs/adapters/claude-code.md.

const READ = new Set(["Read", "NotebookRead", "LSP"]);
const EDIT = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const EXEC = new Set(["Bash", "PowerShell", "BashOutput", "KillShell", "Monitor"]);
const SEARCH = new Set(["Glob", "Grep", "ToolSearch"]);
const WEB = new Set(["WebFetch", "WebSearch"]);
const SUBAGENT = new Set(["Agent", "Task", "Workflow"]);
/** Tools that reach the user as question/plan blocks; a step row for them would be noise. */
const DIALOG = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function toolKind(name: string): ToolKind {
  if (READ.has(name)) return "read";
  if (EDIT.has(name)) return "edit";
  if (EXEC.has(name)) return "exec";
  if (SEARCH.has(name)) return "search";
  if (WEB.has(name)) return "web";
  if (SUBAGENT.has(name)) return "subagent";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface PermissionContext {
  toolUseID: string;
  title?: string;
  displayName?: string;
  decisionReason?: string;
}

export class ClaudeMapper {
  private denied = new Set<string>();
  private lastCostUsd = 0;
  private interrupting = false;

  constructor(private readonly cwd: string) {}

  /** Display path: relative to the chat cwd when inside it. */
  rel(p: string): string {
    if (!isAbsolute(p)) return p;
    const r = relative(this.cwd, p);
    return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
  }

  private paths(input: unknown): string[] {
    if (!isRec(input)) return [];
    const p = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
    return p ? [this.rel(p)] : [];
  }

  markDenied(toolUseId: string): void {
    this.denied.add(toolUseId);
  }

  markInterrupting(): void {
    this.interrupting = true;
  }

  /** The event a `canUseTool` call becomes: a permission, a question or a plan. */
  requestEvent(toolName: string, input: Rec, ctx: PermissionContext): AgentEvent {
    if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) {
      const questions: QuestionSpec[] = input.questions.filter(isRec).map((q) => ({
        question: str(q.question) ?? "",
        ...(str(q.header) !== undefined && { header: str(q.header) }),
        options: (Array.isArray(q.options) ? q.options : []).filter(isRec).map((o) => ({
          label: str(o.label) ?? "",
          ...(str(o.description) !== undefined && { description: str(o.description) }),
        })),
        multiSelect: q.multiSelect === true,
      }));
      return {
        type: "question.asked",
        id: ctx.toolUseID,
        question: questions[0]?.question ?? "",
        options: questions[0]?.options.map((o) => o.label) ?? [],
        questions,
      };
    }
    if (toolName === "ExitPlanMode") {
      return { type: "plan.proposed", id: ctx.toolUseID, markdown: str(input.plan) ?? "_The agent proposed a plan without text._" };
    }
    const command = str(input.command);
    const paths = this.paths(input);
    const name = ctx.displayName ?? toolName;
    return {
      type: "permission.requested",
      id: ctx.toolUseID,
      kind: toolKind(toolName),
      summary: ctx.title ?? (command ? `Run \`${command}\`` : paths[0] ? `${name} ${paths[0]}` : `Use ${name}`),
      ...(command !== undefined && { command }),
      ...(paths.length > 0 && { paths }),
      ...(ctx.decisionReason !== undefined && { reason: ctx.decisionReason }),
    };
  }

  map(m: SDKMessage): AgentEvent[] {
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          this.interrupting = false;
          return [{ type: "session.started", nativeSessionId: m.session_id, model: m.model }];
        }
        return [];

      case "stream_event": {
        // Subagent output stays inside its tool step; only the main thread streams into the chat.
        if (m.parent_tool_use_id) return [];
        const e = m.event;
        if (e.type !== "content_block_delta") return [];
        if (e.delta.type === "text_delta") return [{ type: "message.delta", text: e.delta.text }];
        if (e.delta.type === "thinking_delta" && e.delta.thinking) return [{ type: "thinking.delta", text: e.delta.thinking }];
        return [];
      }

      case "assistant": {
        const out: AgentEvent[] = [];
        for (const b of m.message.content) {
          if (b.type === "text" && !m.parent_tool_use_id) out.push({ type: "message.completed", text: b.text });
          else if (b.type === "tool_use" && !DIALOG.has(b.name)) {
            const paths = this.paths(b.input);
            out.push({
              type: "tool.started",
              id: b.id,
              kind: toolKind(b.name),
              name: b.name,
              input: b.input,
              ...(paths.length > 0 && { paths }),
              ...(m.parent_tool_use_id && { parentId: m.parent_tool_use_id }),
            });
          }
        }
        return out;
      }

      case "user": {
        const content = m.message.content;
        if (!Array.isArray(content)) return [];
        const out: AgentEvent[] = [];
        for (const b of content) {
          if (!isRec(b) || b.type !== "tool_result") continue;
          const id = str(b.tool_use_id) ?? "";
          const status = this.denied.has(id) ? "denied" : b.is_error === true ? "error" : "ok";
          out.push({ type: "tool.completed", id, status, output: summarise(b.content) });
        }
        const fc = this.fileChange(m.tool_use_result);
        if (fc) out.push(fc);
        return out;
      }

      case "rate_limit_event": {
        const info = m.rate_limit_info;
        if (info.status !== "rejected") return [];
        return [
          {
            type: "rate_limited",
            ...(info.resetsAt !== undefined && { resetsAt: new Date(info.resetsAt * 1000).toISOString() }),
            message: `Usage limit reached${info.rateLimitType ? ` (${info.rateLimitType.replaceAll("_", " ")})` : ""}.`,
          },
        ];
      }

      case "result": {
        const costDelta = Math.max(0, m.total_cost_usd - this.lastCostUsd);
        this.lastCostUsd = m.total_cost_usd;
        const out: AgentEvent[] = [
          {
            type: "usage",
            inputTokens: m.usage.input_tokens,
            outputTokens: m.usage.output_tokens,
            costUsd: costDelta,
          },
        ];
        const interrupted = this.interrupting;
        this.interrupting = false;
        if (m.subtype === "success" && !m.is_error) {
          out.push({ type: "turn.completed", status: "ok", durationMs: m.duration_ms });
        } else if (interrupted) {
          out.push({ type: "turn.completed", status: "interrupted", durationMs: m.duration_ms });
        } else {
          const errors = "errors" in m && Array.isArray(m.errors) ? m.errors.filter((x): x is string => typeof x === "string") : [];
          const message = errors.join("\n") || (m.subtype === "success" ? m.result : m.subtype.replaceAll("_", " "));
          out.push({ type: "error", message: message || "The agent reported an error.", recoverable: true });
          out.push({ type: "turn.completed", status: "error", durationMs: m.duration_ms });
        }
        return out;
      }

      default:
        return [];
    }
  }

  private fileChange(result: unknown): AgentEvent | null {
    if (!isRec(result)) return null;
    const filePath = str(result.filePath);
    if (!filePath) return null;
    let hunks: DiffHunk[];
    let change: "created" | "modified" = "modified";
    if (result.type === "create" && typeof result.content === "string") {
      change = "created";
      const lines = result.content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      hunks = [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }];
    } else if (Array.isArray(result.structuredPatch)) {
      hunks = result.structuredPatch.filter(isRec).map((h) => ({
        oldStart: Number(h.oldStart) || 0,
        oldLines: Number(h.oldLines) || 0,
        newStart: Number(h.newStart) || 0,
        newLines: Number(h.newLines) || 0,
        lines: Array.isArray(h.lines) ? h.lines.filter((l): l is string => typeof l === "string") : [],
      }));
      if (result.originalFile === null && result.type === "create") change = "created";
    } else {
      return null;
    }
    const all = hunks.flatMap((h) => h.lines);
    return {
      type: "file.changed",
      path: this.rel(filePath),
      change,
      hunks,
      additions: all.filter((l) => l.startsWith("+")).length,
      deletions: all.filter((l) => l.startsWith("-")).length,
    };
  }
}

/** Tool output for the step row: plain text, truncated so transcripts stay small. */
function summarise(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content))
    text = content
      .map((c) => (isRec(c) && typeof c.text === "string" ? c.text : isRec(c) && c.type ? `[${String(c.type)}]` : ""))
      .filter(Boolean)
      .join("\n");
  else text = "";
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…(${text.length - 4000} more characters)` : text;
}
