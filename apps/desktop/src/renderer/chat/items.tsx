import { useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Copy,
  FileEdit,
  FilePlus,
  FileText,
  Globe,
  Plug,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { FileChange, RespondPayload, ToolKind, TranscriptItem } from "@latis/shared";
import { Button, Chip, cn } from "@latis/ui";
import { Markdown } from "../markdown/Markdown";

const toolIcon: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: FileEdit,
  exec: Terminal,
  search: Search,
  web: Globe,
  mcp: Plug,
  subagent: Bot,
  other: Wrench,
};

export interface ItemActions {
  respond(requestId: string, response: RespondPayload): void;
  openPath(path: string): void;
  /** Checkpoint state of a turn, for ↶ undo / ↷ redo in its footer (§9.4 AC2). */
  turnState?(turnId: string): { files: number; undone: boolean; restorable: boolean } | undefined;
  undo?(turnId: string): void;
  redo?(turnId: string): void;
}

export function Item({ item, actions }: { item: TranscriptItem; actions: ItemActions }) {
  switch (item.kind) {
    case "user":
      return (
        <div
          className="latis-bubble ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[5px] bg-surface-2 px-3 py-2 text-text-1"
          data-testid="user-message"
        >
          {item.text}
        </div>
      );
    case "steer":
      return (
        <div
          className="ml-10 flex items-start gap-1.5 rounded-card border border-dashed border-line px-3 py-2 text-text-1"
          data-testid="steer-message"
        >
          <span className="shrink-0 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent">Steer</span>
          <span className="whitespace-pre-wrap">{item.text}</span>
        </div>
      );
    case "assistant":
      return <AssistantMessage text={item.text} streaming={item.streaming} />;
    case "thinking":
      return (
        <details className="group text-[12px] text-text-3">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1 hover:text-text-2">
            <ChevronRight size={12} className="transition-transform duration-fast group-open:rotate-90" /> Thinking
          </summary>
          <p className="mt-1 whitespace-pre-wrap border-l border-line pl-3 leading-relaxed">{item.text}</p>
        </details>
      );
    case "step":
      return <StepRow item={item} openPath={actions.openPath} />;
    case "file":
      return <FileRow file={item} openPath={actions.openPath} />;
    case "permission":
      return <PermissionBlock item={item} respond={actions.respond} />;
    case "question":
      return <QuestionBlock item={item} respond={actions.respond} />;
    case "plan":
      return <PlanBlock item={item} respond={actions.respond} />;
    case "error":
      return (
        <div className="rounded-control border border-state-error/30 bg-state-error/8 px-3 py-2 text-[13px] text-state-error" role="alert">
          {item.message}
        </div>
      );
    case "turn-end":
      return (
        <div className="flex items-center gap-1.5 border-t border-line pt-2 text-[11px] text-text-3" data-testid="turn-end">
          <span>Worked {formatDuration(item.durationMs)}</span>
          {item.outputTokens !== undefined && <span>· {formatTokens(item.outputTokens)} output tokens</span>}
          {item.costUsd !== undefined && item.costUsd > 0 && (
            <span title="What these tokens would cost on the API. Your plan may bill differently.">
              · ${item.costUsd.toFixed(3)} API-equivalent
            </span>
          )}
          {item.status !== "ok" && <span className="text-state-error">· {item.status}</span>}
          {item.turnId && <UndoTurn turnId={item.turnId} actions={actions} />}
        </div>
      );
  }
}

function UndoTurn({ turnId, actions }: { turnId: string; actions: ItemActions }) {
  const st = actions.turnState?.(turnId);
  if (!st?.restorable || st.files === 0) return null;
  return st.undone ? (
    <button
      className="ml-auto rounded px-1 text-text-2 hover:bg-surface-2 hover:text-text-1"
      onClick={() => actions.redo?.(turnId)}
      data-testid="redo-turn"
    >
      ↷ Redo turn
    </button>
  ) : (
    <button
      className="ml-auto rounded px-1 text-text-2 hover:bg-surface-2 hover:text-text-1"
      onClick={() => actions.undo?.(turnId)}
      title={`Restores the ${st.files} file${st.files === 1 ? "" : "s"} this turn changed`}
      data-testid="undo-turn"
    >
      ↶ Undo turn
    </button>
  );
}

function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative text-text-1" data-testid="assistant-message">
      <Markdown text={text} />
      {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-latis-pulse bg-accent" aria-hidden />}
      {!streaming && text && (
        <button
          aria-label="Copy message"
          className="absolute -right-1 -top-1 rounded-[6px] bg-surface p-1 text-text-3 opacity-0 transition-opacity hover:text-text-1 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}

function StepRow({ item, openPath }: { item: Extract<TranscriptItem, { kind: "step" }>; openPath: (p: string) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon[item.toolKind];
  const input = item.input as Record<string, unknown> | null;
  const command = input && typeof input.command === "string" ? input.command : undefined;
  const pattern = input && typeof input.pattern === "string" ? input.pattern : undefined;
  const target = item.paths[0] ?? command ?? pattern ?? (input && typeof input.description === "string" ? input.description : "");
  const adds = item.files.reduce((n, f) => n + f.additions, 0);
  const dels = item.files.reduce((n, f) => n + f.deletions, 0);
  const verb = item.files.length ? (item.files.every((f) => f.change === "created") ? "Created" : "Edited") : item.name;
  return (
    <div className={cn("text-[12px]", item.parentId && "ml-4 border-l border-line pl-2.5")} data-testid="step">
      <div className="flex items-center gap-1.5 text-text-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-text-1"
          aria-expanded={open}
        >
          <ChevronRight size={12} className={cn("shrink-0 transition-transform duration-fast", open && "rotate-90")} />
          <Icon size={13} className="shrink-0" />
          <span className="shrink-0 font-medium">{verb}</span>
          {item.paths[0] ? (
            <span
              role="link"
              tabIndex={0}
              className="truncate font-mono text-text-3 hover:text-accent hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                openPath(item.paths[0]!);
              }}
              onKeyDown={(e) => e.key === "Enter" && openPath(item.paths[0]!)}
            >
              {target}
            </span>
          ) : (
            <span className="truncate font-mono text-text-3">{target}</span>
          )}
        </button>
        {item.files.length > 0 && (
          <span className="shrink-0 font-mono text-[11px]" data-testid="diff-stat">
            <span className="text-state-done">+{adds}</span> <span className={dels ? "text-state-error" : "text-text-3"}>−{dels}</span>
          </span>
        )}
        <span
          className={cn(
            "shrink-0 text-[11px]",
            item.status === "running" && "animate-latis-pulse text-state-working",
            item.status === "ok" && "text-text-3",
            (item.status === "error" || item.status === "denied") && "text-state-error",
          )}
        >
          {item.status === "running" ? "running" : item.status === "ok" ? "" : item.status}
        </span>
      </div>
      {item.files.length > 0 && !open && (
        <div className="mt-1 pl-5">
          {item.files.map((f) => (
            <DiffView key={f.path} file={f} compact />
          ))}
        </div>
      )}
      {open && (
        <div className="mt-1 space-y-1 pl-5">
          <pre className="max-h-48 overflow-auto rounded-control bg-bg-1 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-text-2">
            <span className="text-text-3">IN </span>
            {JSON.stringify(item.input, null, 2)}
          </pre>
          {typeof item.output === "string" && item.output && (
            <pre className="max-h-48 overflow-auto rounded-control bg-bg-1 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-text-2">
              <span className="text-text-3">OUT </span>
              {item.output}
            </pre>
          )}
          {item.files.map((f) => (
            <DiffView key={f.path} file={f} />
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({ file, openPath }: { file: FileChange; openPath: (p: string) => void }) {
  return (
    <div className="text-[12px]">
      <button className="flex items-center gap-1.5 font-mono text-text-2 hover:text-accent" onClick={() => openPath(file.path)}>
        <FilePlus size={13} className="text-state-done" /> {file.change} {file.path}
        {file.hunks.length > 0 && (
          <span className="ml-1">
            <span className="text-state-done">+{file.additions}</span> <span className="text-state-error">−{file.deletions}</span>
          </span>
        )}
      </button>
      {file.hunks.length > 0 && <DiffView file={file} compact />}
    </div>
  );
}

const COMPACT_LINES = 12;

/** Inline unified diff (§8.5). `compact` shows the first lines with an expander. */
function DiffView({ file, compact }: { file: FileChange; compact?: boolean }) {
  const [all, setAll] = useState(!compact);
  const lines = file.hunks.flatMap((h, i) => [
    ...(i > 0 || h.oldStart > 1 ? [{ t: "@", s: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` }] : []),
    ...h.lines.filter((l) => !l.startsWith("\\")).map((l) => ({ t: l[0] ?? " ", s: l.slice(1) })),
  ]);
  if (!lines.length) return null;
  const shown = all ? lines : lines.slice(0, COMPACT_LINES);
  return (
    <div className="my-1 overflow-hidden rounded-control border border-line bg-bg-1 font-mono text-[11px] leading-[1.6]" data-testid="diff">
      <div className="max-h-72 overflow-auto">
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre px-2",
              l.t === "+" && "bg-state-done/12 text-text-1",
              l.t === "-" && "bg-state-error/12 text-text-1",
              l.t === "@" && "text-text-3",
              l.t === " " && "text-text-2",
            )}
          >
            <span className="mr-2 inline-block w-2 select-none text-text-3">{l.t === "@" ? "" : l.t}</span>
            {l.s || " "}
          </div>
        ))}
      </div>
      {!all && lines.length > COMPACT_LINES && (
        <button className="w-full border-t border-line py-0.5 text-[10.5px] text-text-3 hover:text-text-1" onClick={() => setAll(true)}>
          Show {lines.length - COMPACT_LINES} more lines
        </button>
      )}
    </div>
  );
}

function RequestShell({
  title,
  pending,
  children,
  testId,
  summary,
}: {
  title: string;
  pending: boolean;
  children: React.ReactNode;
  testId: string;
  summary: string;
}) {
  if (!pending) {
    // Answered requests collapse to one line; the details stay one click away.
    return (
      <details className="group text-[12px] text-text-3" data-testid={testId} data-pending={false}>
        <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 hover:text-text-2">
          <Check size={12} className="text-state-done" />
          <span className="font-medium">{title}</span>
          <span className="truncate">{summary}</span>
        </summary>
        <div className="mt-1 border-l border-line pl-3 text-[13px] text-text-2">{children}</div>
      </details>
    );
  }
  return (
    <div
      className={cn(
        "rounded-control border px-3 py-2.5 text-[13px]",
        pending ? "border-state-needs-you/45 bg-state-needs-you/8" : "border-line opacity-75",
      )}
      data-testid={testId}
      data-pending={pending}
    >
      <div className="text-[11px] font-semibold uppercase tracking-wide text-text-3">{title}</div>
      {children}
    </div>
  );
}

function PermissionBlock({ item, respond }: { item: Extract<TranscriptItem, { kind: "permission" }>; respond: ItemActions["respond"] }) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <RequestShell title="Permission" pending={item.pending} testId="permission" summary={item.summary.replaceAll("`", "")}>
      <div className="mt-1 text-text-1">
        <Markdown text={item.summary} />
        {item.command && !item.summary.includes(item.command) && (
          <pre
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-control bg-bg-1 px-2 py-1.5 font-mono text-[12px] text-text-1"
            data-testid="permission-command"
          >
            {item.command}
          </pre>
        )}
        {item.reason && <div className="mt-0.5 text-[12px] text-text-3">Reason: {item.reason}</div>}
      </div>
      {item.pending ? (
        denying ? (
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              respond(item.id, { kind: "permission", decision: "deny", ...(reason.trim() && { reason: reason.trim() }) });
            }}
          >
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why not? (optional, sent to the agent)"
              className="h-7 min-w-0 flex-1 rounded-control border border-line bg-bg-1 px-2 text-[12px] text-text-1 outline-none focus:border-line-strong"
            />
            <Button size="sm" variant="danger" type="submit" data-testid="deny-confirm">
              Deny
            </Button>
          </form>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant="primary"
              onClick={() => respond(item.id, { kind: "permission", decision: "allow-once" })}
              data-testid="allow-once"
            >
              Allow once
            </Button>
            <Button size="sm" onClick={() => respond(item.id, { kind: "permission", decision: "allow-chat" })} data-testid="allow-chat">
              Always for this chat
            </Button>
            <Button size="sm" variant="ghost" onClick={() => respond(item.id, { kind: "permission", decision: "deny" })} data-testid="deny">
              Deny
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDenying(true)}>
              Deny with reason…
            </Button>
          </div>
        )
      ) : null}
    </RequestShell>
  );
}

function QuestionBlock({ item, respond }: { item: Extract<TranscriptItem, { kind: "question" }>; respond: ItemActions["respond"] }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answerOf = (q: string) => (other[q]?.trim() ? other[q].trim() : (picked[q] ?? []).join(", "));
  const complete = item.questions.every((q) => answerOf(q.question));
  return (
    <RequestShell
      title={item.questions.length > 1 ? "Questions" : "Question"}
      pending={item.pending}
      testId="question"
      summary={item.questions.map((q) => q.question).join(" · ")}
    >
      <div className="mt-1.5 space-y-3">
        {item.questions.map((q) => (
          <fieldset key={q.question} disabled={!item.pending}>
            <legend className="mb-1.5 flex items-center gap-1.5 text-text-1">
              {q.header && <Chip>{q.header}</Chip>}
              <span>{q.question}</span>
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    title={o.description}
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((p) => {
                        const cur = p[q.question] ?? [];
                        const next = q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                        return { ...p, [q.question]: next };
                      })
                    }
                    className={cn(
                      "rounded-control border px-2.5 py-1 text-left text-[12px] transition-colors duration-fast",
                      on ? "border-accent bg-accent/12 text-text-1" : "border-line bg-surface-2 text-text-2 hover:text-text-1",
                    )}
                  >
                    <div className="font-medium">{o.label}</div>
                    {o.description && <div className="text-[11px] text-text-3">{o.description}</div>}
                  </button>
                );
              })}
            </div>
            {item.pending && (
              <input
                value={other[q.question] ?? ""}
                onChange={(e) => setOther((o) => ({ ...o, [q.question]: e.target.value }))}
                placeholder="Or type your own answer"
                className="mt-1.5 h-7 w-full rounded-control border border-line bg-bg-1 px-2 text-[12px] text-text-1 outline-none focus:border-line-strong"
              />
            )}
          </fieldset>
        ))}
      </div>
      {item.pending ? (
        <div className="mt-2.5 flex gap-1.5">
          <Button
            size="sm"
            variant="primary"
            disabled={!complete}
            onClick={() =>
              respond(item.id, {
                kind: "answer",
                answers: Object.fromEntries(item.questions.map((q) => [q.question, answerOf(q.question)])),
              })
            }
            data-testid="answer"
          >
            Answer
          </Button>
        </div>
      ) : null}
    </RequestShell>
  );
}

function PlanBlock({ item, respond }: { item: Extract<TranscriptItem, { kind: "plan" }>; respond: ItemActions["respond"] }) {
  const [feedback, setFeedback] = useState("");
  return (
    <RequestShell
      title="Plan"
      pending={item.pending}
      testId="plan"
      summary={
        item.markdown
          .split("\n")
          .find((l) => l.trim())
          ?.replace(/^#+\s*/, "") ?? ""
      }
    >
      <div className="mt-1.5 max-h-80 overflow-y-auto rounded-control bg-bg-1 px-3 py-2 text-[13px]">
        <Markdown text={item.markdown} />
      </div>
      {item.pending ? (
        <div className="mt-2 flex gap-1.5">
          <Button size="sm" variant="primary" onClick={() => respond(item.id, { kind: "plan", approve: true })} data-testid="approve-plan">
            Approve
          </Button>
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What should change?"
            className="h-7 min-w-0 flex-1 rounded-control border border-line bg-bg-1 px-2 text-[12px] text-text-1 outline-none focus:border-line-strong"
          />
          <Button
            size="sm"
            onClick={() => respond(item.id, { kind: "plan", approve: false, ...(feedback.trim() && { feedback: feedback.trim() }) })}
          >
            Keep planning
          </Button>
        </div>
      ) : null}
    </RequestShell>
  );
}

export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
