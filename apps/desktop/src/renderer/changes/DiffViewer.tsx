import { memo, useEffect, useMemo, useState } from "react";
import { Check, MessageSquare, Undo2 } from "lucide-react";
import type { DiffHunk, FileDiff } from "@lattiz/shared";
import { Button, cn } from "@lattiz/ui";
import { highlight } from "../markdown/highlight";

// Diff viewer (§9.5 AC2): unified or split, highlighted per side with the Shiki worker.

const LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  css: "css",
  scss: "scss",
  html: "html",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  java: "java",
  rb: "ruby",
  swift: "swift",
  kt: "kotlin",
};
export const langOf = (path: string) => LANGS[path.split(".").pop()?.toLowerCase() ?? ""] ?? "text";

/** Highlighted HTML per line, or null while (or if) it can't be highlighted. */
function useLines(lines: string[], lang: string): string[] | null {
  const code = lines.join("\n");
  const [html, setHtml] = useState<{ code: string; lines: string[] } | null>(null);
  useEffect(() => {
    if (lang === "text" || !code) return;
    let live = true;
    void highlight(code, lang).then((h) => {
      if (!live || !h) return;
      const doc = new DOMParser().parseFromString(h, "text/html");
      setHtml({ code, lines: [...doc.querySelectorAll(".line")].map((l) => l.innerHTML) });
    });
    return () => {
      live = false;
    };
  }, [code, lang]);
  return html?.code === code ? html.lines : null;
}

interface Row {
  kind: " " | "+" | "-";
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Index into the highlighted old / new side. */
  oldIdx?: number;
  newIdx?: number;
}

function rows(h: DiffHunk): { rows: Row[]; oldSide: string[]; newSide: string[] } {
  const out: Row[] = [];
  const oldSide: string[] = [];
  const newSide: string[] = [];
  let o = h.oldStart;
  let n = h.newStart;
  for (const raw of h.lines) {
    if (raw.startsWith("\\")) continue;
    const kind = (raw[0] ?? " ") as Row["kind"];
    const text = raw.slice(1);
    if (kind === "-") {
      out.push({ kind, text, oldNo: o++, oldIdx: oldSide.push(text) - 1 });
    } else if (kind === "+") {
      out.push({ kind, text, newNo: n++, newIdx: newSide.push(text) - 1 });
    } else {
      out.push({ kind: " ", text, oldNo: o++, newNo: n++, oldIdx: oldSide.push(text) - 1, newIdx: newSide.push(text) - 1 });
    }
  }
  return { rows: out, oldSide, newSide };
}

function Code({ html, text }: { html: string | undefined; text: string }) {
  // Shiki output is escaped HTML produced locally from the file's own text.
  return html !== undefined ? <span dangerouslySetInnerHTML={{ __html: html || " " }} /> : <span>{text || " "}</span>;
}

const lineClass = (k: Row["kind"]) => cn("whitespace-pre pr-3", k === "+" && "bg-state-done/12", k === "-" && "bg-state-error/12");

export const HunkView = memo(function HunkView({ hunk, lang, split }: { hunk: DiffHunk; lang: string; split: boolean }) {
  const { rows: list, oldSide, newSide } = useMemo(() => rows(hunk), [hunk]);
  const oldHtml = useLines(oldSide, lang);
  const newHtml = useLines(newSide, lang);
  const num = "w-10 shrink-0 select-none pr-2 text-right text-text-3";
  if (!split) {
    return (
      <div className="font-mono text-[12px] leading-[1.65]">
        {list.map((r, i) => (
          <div key={i} className={cn("flex", lineClass(r.kind))}>
            <span className={num}>{r.oldNo ?? ""}</span>
            <span className={num}>{r.newNo ?? ""}</span>
            <span className="w-4 shrink-0 select-none text-text-3">{r.kind === " " ? "" : r.kind}</span>
            <Code html={r.kind === "-" ? oldHtml?.[r.oldIdx!] : newHtml?.[r.newIdx!]} text={r.text} />
          </div>
        ))}
      </div>
    );
  }
  // Split: context on both sides; runs of removals pair up with the additions that follow.
  const pairs: [Row | null, Row | null][] = [];
  for (let i = 0; i < list.length;) {
    const r = list[i]!;
    if (r.kind === " ") {
      pairs.push([r, r]);
      i++;
      continue;
    }
    const minus: Row[] = [];
    const plus: Row[] = [];
    while (list[i]?.kind === "-") minus.push(list[i++]!);
    while (list[i]?.kind === "+") plus.push(list[i++]!);
    for (let j = 0; j < Math.max(minus.length, plus.length); j++) pairs.push([minus[j] ?? null, plus[j] ?? null]);
  }
  return (
    <div className="grid grid-cols-2 font-mono text-[12px] leading-[1.65]">
      {pairs.map(([l, r], i) => (
        <div key={i} className="contents">
          <div className={cn("flex overflow-hidden border-r border-line", l && l.kind !== " " && lineClass("-"))}>
            <span className={num}>{l?.oldNo ?? ""}</span>
            {l && <Code html={oldHtml?.[l.oldIdx!]} text={l.text} />}
          </div>
          <div className={cn("flex overflow-hidden", r && r.kind !== " " && lineClass("+"))}>
            <span className={num}>{r?.newNo ?? ""}</span>
            {r && <Code html={newHtml?.[r.newIdx!]} text={r.text} />}
          </div>
        </div>
      ))}
    </div>
  );
});

export type Decision = "accepted" | "reverted" | undefined;

export interface FileActions {
  accept?: (hunk?: number) => Promise<void>;
  revert?: (hunk?: number) => Promise<void>;
  ask?: (feedback: string, hunk?: number) => Promise<void>;
}

function Ask({ onSend, onCancel }: { onSend: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  return (
    <form
      className="flex gap-1.5 border-t border-line bg-bg-1 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSend(text.trim());
      }}
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder="What should change? Sent to the chat with this change quoted."
        className="h-7 min-w-0 flex-1 rounded-control border border-line bg-surface px-2 text-[12px] text-text-1 outline-none focus:border-line-strong"
        data-testid="ask-input"
      />
      <Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>
        Send
      </Button>
    </form>
  );
}

function Actions({ decision, actions, hunk, onAsk }: { decision: Decision; actions: FileActions; hunk?: number; onAsk: () => void }) {
  if (decision) {
    return (
      <span className={cn("text-[11px] font-medium", decision === "accepted" ? "text-state-done" : "text-text-3")} data-testid="decision">
        {decision === "accepted" ? "Accepted" : "Reverted"}
      </span>
    );
  }
  return (
    <span className="flex gap-1">
      {actions.accept && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void actions.accept!(hunk)}
          data-testid={hunk === undefined ? "accept-file" : "accept-hunk"}
        >
          <Check size={12} /> Accept
        </Button>
      )}
      {actions.revert && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void actions.revert!(hunk)}
          data-testid={hunk === undefined ? "revert-file" : "revert-hunk"}
        >
          <Undo2 size={12} /> Revert
        </Button>
      )}
      {actions.ask && (
        <Button size="sm" variant="ghost" onClick={onAsk} data-testid="ask-changes">
          <MessageSquare size={12} /> Ask for changes
        </Button>
      )}
    </span>
  );
}

export function FileDiffView({
  file,
  split,
  decisions,
  actions,
}: {
  file: FileDiff;
  split: boolean;
  decisions?: { file?: "accepted" | "reverted"; hunks?: Record<string, "accepted" | "reverted"> };
  actions: FileActions;
}) {
  const lang = langOf(file.path);
  const [asking, setAsking] = useState<number | "file" | null>(null);
  const send = (text: string) => {
    const h = asking === "file" || asking === null ? undefined : asking;
    void actions.ask?.(text, h).then(() => setAsking(null));
  };
  return (
    <section className="overflow-hidden rounded-panel border border-line bg-surface" data-testid="file-diff" data-path={file.path}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-1">
          {file.oldPath && <span className="text-text-3">{file.oldPath} → </span>}
          {file.path}
        </span>
        <span className="text-[11px] text-text-3">{file.change}</span>
        <span className="font-mono text-[11px] text-state-done">+{file.additions}</span>
        <span className="font-mono text-[11px] text-state-error">−{file.deletions}</span>
        <Actions decision={decisions?.file} actions={actions} onAsk={() => setAsking("file")} />
      </header>
      {asking === "file" && <Ask onSend={send} onCancel={() => setAsking(null)} />}
      {file.binary && <p className="px-3 py-2 text-[12px] text-text-3">Binary file.</p>}
      {file.hunks.map((h, i) => {
        const d: Decision = decisions?.file ?? decisions?.hunks?.[String(i)];
        return (
          <div key={i} className={cn("border-b border-line last:border-b-0", d === "reverted" && "opacity-50")} data-testid="hunk">
            <div className="flex items-center gap-2 bg-bg-1 px-3 py-0.5 font-mono text-[11px] text-text-3">
              <span className="flex-1">
                @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines}
              </span>
              {file.hunks.length > 1 && <Actions decision={d} actions={actions} hunk={i} onAsk={() => setAsking(i)} />}
            </div>
            <div className="overflow-x-auto">
              <HunkView hunk={h} lang={lang} split={split} />
            </div>
            {asking === i && <Ask onSend={send} onCancel={() => setAsking(null)} />}
          </div>
        );
      })}
    </section>
  );
}
