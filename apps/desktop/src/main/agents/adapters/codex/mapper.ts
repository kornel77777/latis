import { isAbsolute, relative } from "node:path";
import { countChanges, parseUnifiedDiff, type AgentEvent, type QuestionSpec, type ToolKind } from "@latis/shared";
import type { Params } from "../../rpc/peer";

// Codex app-server notifications → AgentEvents (docs/adapters/codex.md).
// The subset of the generated protocol types (`codex app-server generate-ts`) that Latis reads.

interface CommandAction {
  type: "read" | "listFiles" | "search" | "unknown";
  command: string;
  path?: string | null;
}
interface FileUpdateChange {
  path: string;
  kind: { type: "add" | "delete" | "update" };
  diff: string;
}
type ThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      commandActions: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: "inProgress" | "completed" | "failed" | "declined" }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; arguments: unknown; status: string; error: unknown }
  | { type: "dynamicToolCall"; id: string; tool: string; arguments: unknown; status: string; success: boolean | null }
  | { type: "webSearch"; id: string; query?: string }
  | { type: "collabAgentToolCall"; id: string; tool: string; prompt: string | null; status: string }
  | { type: string; id: string };

interface TurnInfo {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error: { message: string } | null;
  durationMs: number | null;
}
interface TokenUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
}

/** What a server request needs from the user, plus what Latis needs to auto-answer it. */
export interface CodexRequest {
  requestId: string;
  event: AgentEvent;
  /** Every path is inside the chat's folder (patches) — Auto-edit accepts these itself. */
  editInsideCwd: boolean;
  /** The command only reads (Codex's own parse) — Ask and Auto-edit accept these itself. */
  pureRead: boolean;
  /** Question ids by question text, for building the answer. */
  questionIds?: Record<string, string>;
}

const SHELL_WRAPPER = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh -l?c (['"])([\s\S]*)\1$/;
const READ_ACTIONS = new Set(["read", "listFiles", "search"]);

/** `/bin/zsh -lc 'ls -la'` → `ls -la` (Codex wraps every command in the login shell). */
export function unwrapCommand(command: string): string {
  const m = SHELL_WRAPPER.exec(command.trim());
  if (!m) return command;
  const body = m[2]!;
  return m[1] === "'" ? body.replaceAll(`'\\''`, "'") : body.replace(/\\(["\\$`])/g, "$1");
}

export class CodexMapper {
  private items = new Map<string, ThreadItem>();
  private open = new Set<string>();
  private turnStart = 0;
  private usageAtTurnStart: TokenUsage | null = null;
  private usage: TokenUsage | null = null;

  constructor(private readonly cwd: string) {}

  private rel(p: string): string {
    if (!isAbsolute(p)) return p;
    const r = relative(this.cwd, p);
    return r.startsWith("..") ? p : r;
  }

  private insideCwd(p: string): boolean {
    const r = relative(this.cwd, p);
    return !r.startsWith("..") && !isAbsolute(r);
  }

  private toolStarted(item: ThreadItem): AgentEvent | null {
    switch (item.type) {
      case "commandExecution": {
        const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
        const actions = it.commandActions ?? [];
        const kind: ToolKind =
          actions.length && actions.every((a) => READ_ACTIONS.has(a.type))
            ? actions.some((a) => a.type === "search")
              ? "search"
              : "read"
            : "exec";
        const paths = actions.flatMap((a) => (a.type === "read" && a.path ? [this.rel(a.path)] : []));
        return {
          type: "tool.started",
          id: it.id,
          kind,
          name: "Shell",
          input: { command: unwrapCommand(it.command) },
          ...(paths.length && { paths }),
        };
      }
      case "fileChange": {
        const it = item as Extract<ThreadItem, { type: "fileChange" }>;
        const paths = it.changes.map((c) => this.rel(c.path));
        return { type: "tool.started", id: it.id, kind: "edit", name: "Edit", input: { files: paths }, paths };
      }
      case "mcpToolCall": {
        const it = item as Extract<ThreadItem, { type: "mcpToolCall" }>;
        return { type: "tool.started", id: it.id, kind: "mcp", name: `${it.server}.${it.tool}`, input: it.arguments };
      }
      case "dynamicToolCall": {
        const it = item as Extract<ThreadItem, { type: "dynamicToolCall" }>;
        return { type: "tool.started", id: it.id, kind: "other", name: it.tool, input: it.arguments };
      }
      case "webSearch": {
        const it = item as Extract<ThreadItem, { type: "webSearch" }>;
        return { type: "tool.started", id: it.id, kind: "web", name: "WebSearch", input: { query: it.query ?? "" } };
      }
      case "collabAgentToolCall": {
        const it = item as Extract<ThreadItem, { type: "collabAgentToolCall" }>;
        return { type: "tool.started", id: it.id, kind: "subagent", name: "Agent", input: { prompt: it.prompt ?? "" } };
      }
      default:
        return null;
    }
  }

  private itemCompleted(item: ThreadItem): AgentEvent[] {
    if (item.type === "agentMessage")
      return [{ type: "message.completed", text: (item as Extract<ThreadItem, { type: "agentMessage" }>).text }];
    if (!this.open.has(item.id)) return [];
    this.open.delete(item.id);
    const st = (item as { status?: string }).status;
    const status = st === "declined" ? "denied" : st === "failed" ? "error" : "ok";
    if (item.type === "commandExecution") {
      const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
      return [{ type: "tool.completed", id: it.id, status, ...(it.aggregatedOutput && { output: it.aggregatedOutput }) }];
    }
    if (item.type === "fileChange" && status === "ok") {
      const it = item as Extract<ThreadItem, { type: "fileChange" }>;
      const files: AgentEvent[] = it.changes.map((c) => {
        const hunks = parseUnifiedDiff(c.diff);
        const change = c.kind.type === "add" ? "created" : c.kind.type === "delete" ? "deleted" : "modified";
        return { type: "file.changed", path: this.rel(c.path), change, hunks, ...countChanges(hunks) };
      });
      return [...files, { type: "tool.completed", id: it.id, status }];
    }
    if (item.type === "dynamicToolCall" && (item as { success?: boolean | null }).success === false) {
      return [{ type: "tool.completed", id: item.id, status: "error" }];
    }
    if (item.type === "mcpToolCall" && (item as { error?: unknown }).error) {
      return [{ type: "tool.completed", id: item.id, status: "error", output: (item as { error?: unknown }).error }];
    }
    return [{ type: "tool.completed", id: item.id, status }];
  }

  /** Maps one notification. Unknown or uninteresting notifications map to nothing. */
  notification(method: string, params: Params): AgentEvent[] {
    switch (method) {
      case "turn/started":
        this.turnStart = Date.now();
        this.usageAtTurnStart = this.usage;
        return [];
      case "item/started": {
        const item = params.item as ThreadItem;
        this.items.set(item.id, item);
        const e = this.toolStarted(item);
        if (!e) return [];
        this.open.add(item.id);
        return [e];
      }
      case "item/completed":
        return this.itemCompleted(params.item as ThreadItem);
      case "item/agentMessage/delta":
        return [{ type: "message.delta", text: String(params.delta ?? "") }];
      case "item/reasoning/summaryTextDelta":
        return [{ type: "thinking.delta", text: String(params.delta ?? "") }];
      case "thread/tokenUsage/updated":
        this.usage = (params.tokenUsage as { total: TokenUsage }).total;
        return [];
      case "error": {
        if (params.willRetry) return [];
        const err = params.error as { message: string; codexErrorInfo?: unknown };
        if (err.codexErrorInfo === "usageLimitExceeded" || err.codexErrorInfo === "rateLimitExceeded") {
          return [{ type: "rate_limited", message: err.message }];
        }
        return [{ type: "error", message: err.message, recoverable: true }];
      }
      case "turn/completed": {
        const turn = params.turn as TurnInfo;
        const out: AgentEvent[] = [];
        // An interrupt leaves running items without item/completed.
        for (const id of this.open) out.push({ type: "tool.completed", id, status: "error", output: "Stopped" });
        this.open.clear();
        if (this.usage) {
          const base = this.usageAtTurnStart;
          out.push({
            type: "usage",
            inputTokens: this.usage.inputTokens - (base?.inputTokens ?? 0),
            outputTokens: this.usage.outputTokens - (base?.outputTokens ?? 0),
          });
        }
        const status = turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "error" : "ok";
        out.push({ type: "turn.completed", status, durationMs: turn.durationMs ?? Date.now() - this.turnStart });
        return out;
      }
      default:
        return [];
    }
  }

  /** Maps a server→client request to a Latis request, or null if Latis doesn't handle it. */
  request(method: string, params: Params): CodexRequest | null {
    const itemId = String(params.itemId ?? "");
    const requestId = params.approvalId ? `${itemId}:${String(params.approvalId)}` : itemId;
    const reason = typeof params.reason === "string" && params.reason ? params.reason : undefined;
    if (method === "item/commandExecution/requestApproval") {
      const command = unwrapCommand(String(params.command ?? ""));
      const actions = (params.commandActions as CommandAction[] | null) ?? [];
      return {
        requestId,
        event: { type: "permission.requested", id: requestId, kind: "exec", summary: "Run a command", command, ...(reason && { reason }) },
        editInsideCwd: false,
        pureRead: actions.length > 0 && actions.every((a) => READ_ACTIONS.has(a.type)),
      };
    }
    if (method === "item/fileChange/requestApproval") {
      const item = this.items.get(itemId) as Extract<ThreadItem, { type: "fileChange" }> | undefined;
      const abs = item?.changes.map((c) => c.path) ?? [];
      const paths = abs.map((p) => this.rel(p));
      const summary = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`;
      return {
        requestId,
        event: { type: "permission.requested", id: requestId, kind: "edit", summary, paths, ...(reason && { reason }) },
        editInsideCwd: abs.length > 0 && !params.grantRoot && abs.every((p) => this.insideCwd(p)),
        pureRead: false,
      };
    }
    if (method === "item/tool/requestUserInput") {
      const qs =
        (params.questions as {
          id: string;
          header: string;
          question: string;
          options: { label: string; description: string }[] | null;
        }[]) ?? [];
      const questions: QuestionSpec[] = qs.map((q) => ({
        question: q.question,
        ...(q.header && { header: q.header }),
        options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description && { description: o.description }) })),
      }));
      return {
        requestId,
        event: { type: "question.asked", id: requestId, question: qs[0]?.question ?? "", questions },
        editInsideCwd: false,
        pureRead: false,
        questionIds: Object.fromEntries(qs.map((q) => [q.question, q.id])),
      };
    }
    return null;
  }
}
