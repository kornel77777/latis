import type { DiffHunk, QuestionSpec, StoredEvent, ToolKind } from "./agent-events";
import type { Turn } from "./ipc-contract";

// Pure projection of turns + events into renderable transcript items (SPEC §6.2:
// a transcript can be fully re-rendered from its events).

export interface FileChange {
  path: string;
  change: "created" | "modified" | "deleted";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export type TranscriptItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "steer"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string; streaming: boolean }
  | { kind: "thinking"; key: string; text: string }
  | {
      kind: "step";
      key: string;
      toolKind: ToolKind;
      name: string;
      paths: string[];
      status: "running" | "ok" | "error" | "denied";
      input: unknown;
      output: unknown;
      files: FileChange[];
      parentId?: string;
    }
  | ({ kind: "file"; key: string } & FileChange)
  | { kind: "permission"; key: string; id: string; summary: string; command?: string; reason?: string; pending: boolean }
  | { kind: "question"; key: string; id: string; questions: QuestionSpec[]; pending: boolean }
  | { kind: "plan"; key: string; id: string; markdown: string; pending: boolean }
  | { kind: "error"; key: string; message: string }
  | { kind: "turn-end"; key: string; status: string; durationMs: number; outputTokens?: number; costUsd?: number };

export function buildTranscript(turns: Turn[], events: StoredEvent[]): TranscriptItem[] {
  const byTurn = new Map<string | null, StoredEvent[]>();
  for (const se of events) {
    const list = byTurn.get(se.turnId) ?? [];
    list.push(se);
    byTurn.set(se.turnId, list);
  }
  const items: TranscriptItem[] = [];
  const orphan = byTurn.get(null);
  if (orphan) items.push(...projectTurn(orphan));
  for (const t of [...turns].sort((a, b) => a.seq - b.seq)) {
    items.push({ kind: "user", key: `u-${t.id}`, text: t.userText });
    items.push(...projectTurn(byTurn.get(t.id) ?? []));
  }
  return items;
}

function projectTurn(events: StoredEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const steps = new Map<string, Extract<TranscriptItem, { kind: "step" }>>();
  let assistant: Extract<TranscriptItem, { kind: "assistant" }> | null = null;
  let thinking: Extract<TranscriptItem, { kind: "thinking" }> | null = null;
  let outputTokens: number | undefined;
  let costUsd: number | undefined;

  for (const se of events) {
    const e = se.event;
    const key = `${se.chatId}-${se.seq}`;
    // The agent blocks while a request is open, so any later agent event means it was answered.
    if (e.type !== "user.steered") {
      for (const it of items) if (it.kind === "permission" || it.kind === "question" || it.kind === "plan") it.pending = false;
    }
    if (e.type !== "message.delta" && e.type !== "message.completed") {
      if (assistant) assistant.streaming = false;
      if (e.type !== "usage") assistant = null;
    }
    if (e.type !== "thinking.delta") thinking = null;

    switch (e.type) {
      case "message.delta":
        if (!assistant) {
          assistant = { kind: "assistant", key, text: "", streaming: true };
          items.push(assistant);
        }
        assistant.text += e.text;
        break;
      case "message.completed":
        if (!assistant) {
          assistant = { kind: "assistant", key, text: "", streaming: false };
          items.push(assistant);
        }
        assistant.text = e.text;
        assistant.streaming = false;
        assistant = null;
        break;
      case "thinking.delta":
        if (!thinking) {
          thinking = { kind: "thinking", key, text: "" };
          items.push(thinking);
        }
        thinking.text += e.text;
        break;
      case "tool.started": {
        const step = {
          kind: "step" as const,
          key,
          toolKind: e.kind,
          name: e.name,
          paths: e.paths ?? [],
          status: "running" as const,
          input: e.input,
          output: undefined,
          files: [],
          ...(e.parentId !== undefined && { parentId: e.parentId }),
        };
        steps.set(e.id, step);
        items.push(step);
        break;
      }
      case "tool.completed": {
        const step = steps.get(e.id);
        if (step) {
          step.status = e.status;
          step.output = e.output;
        }
        break;
      }
      case "file.changed": {
        const fc: FileChange = {
          path: e.path,
          change: e.change,
          hunks: e.hunks ?? [],
          additions: e.additions ?? 0,
          deletions: e.deletions ?? 0,
        };
        // Attach to the step that edited this file, newest first; otherwise show on its own.
        const owner = [...steps.values()].reverse().find((s) => s.paths.includes(e.path));
        if (owner) owner.files.push(fc);
        else items.push({ kind: "file", key, ...fc });
        break;
      }
      case "question.asked":
        items.push({
          kind: "question",
          key,
          id: e.id,
          questions: e.questions ?? [{ question: e.question, options: (e.options ?? []).map((label) => ({ label })) }],
          pending: true,
        });
        break;
      case "user.steered":
        items.push({ kind: "steer", key, text: e.text });
        break;
      case "plan.proposed":
        items.push({ kind: "plan", key, id: e.id, markdown: e.markdown, pending: true });
        break;
      case "permission.requested":
        items.push({
          kind: "permission",
          key,
          id: e.id,
          summary: e.summary,
          ...(e.command !== undefined && { command: e.command }),
          ...(e.reason !== undefined && { reason: e.reason }),
          pending: true,
        });
        break;
      case "usage":
        if (e.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + e.outputTokens;
        if (e.costUsd !== undefined) costUsd = (costUsd ?? 0) + e.costUsd;
        break;
      case "error":
        items.push({ kind: "error", key, message: e.message });
        for (const s of steps.values()) if (s.status === "running") s.status = "error";
        break;
      case "turn.completed":
        for (const s of steps.values()) if (s.status === "running") s.status = e.status === "ok" ? "ok" : "error";
        items.push({
          kind: "turn-end",
          key,
          status: e.status,
          durationMs: e.durationMs,
          ...(outputTokens !== undefined && { outputTokens }),
          ...(costUsd !== undefined && { costUsd }),
        });
        break;
      default:
        break;
    }
  }
  return items;
}
