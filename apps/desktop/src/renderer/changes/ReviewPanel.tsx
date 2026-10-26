import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCheck, Columns2, GitMerge, Rows3, X } from "lucide-react";
import type { FileDiff, ReviewItem } from "@latis/shared";
import { Button, cn } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";
import { FileDiffView } from "./DiffViewer";

// Review Inbox (§8.9, §9.5): every finished turn that changed files, reviewable hunk by hunk.

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

export function ReviewPanel() {
  const panel = useWorkspace((s) => s.reviewPanel);
  const reviews = useWorkspace((s) => s.reviews);
  const chats = useWorkspace((s) => s.chats);
  const projects = useWorkspace((s) => s.projects);
  const agents = useWorkspace((s) => s.agents);
  const { closeReview, openReview, updateReview, toast } = useWorkspace.getState();
  const [project, setProject] = useState("");
  const [agent, setAgent] = useState("");
  const [showReviewed, setShowReviewed] = useState(false);
  const [split, setSplit] = useState(false);
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keyboard (§8.12): ↑/↓ or k/j between items, a = accept all, m = mark reviewed, Esc closes.
  const keys = useRef<{ next: (d: 1 | -1) => void; acceptAll: () => void; mark: () => void }>(null);
  const root = useRef<HTMLDivElement>(null);
  // Opening the panel takes focus from wherever it was (a composer, the canvas).
  useEffect(() => {
    if (panel.open) root.current?.focus();
  }, [panel.open]);
  useEffect(() => {
    if (!panel.open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "Escape") closeReview();
      else if (e.key === "ArrowDown" || e.key === "j") keys.current?.next(1);
      else if (e.key === "ArrowUp" || e.key === "k") keys.current?.next(-1);
      else if (e.key === "a") keys.current?.acceptAll();
      else if (e.key === "m") keys.current?.mark();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel.open, closeReview]);

  const visible = useMemo(
    () =>
      reviews.filter((r) => {
        const c = chats[r.chatId]?.summary;
        if (!c) return false;
        if (!showReviewed && r.reviewedAt !== null && r.id !== panel.reviewId) return false;
        if (project && c.projectId !== project) return false;
        if (agent && c.agentId !== agent) return false;
        return true;
      }),
    [reviews, chats, showReviewed, project, agent, panel.reviewId],
  );
  const current = panel.branchOf ? undefined : (reviews.find((r) => r.id === panel.reviewId) ?? visible[0]);
  const target = panel.branchOf ?? current?.id;

  useEffect(() => {
    if (!panel.open || !target) return;
    let live = true;
    const load = panel.branchOf
      ? latis.invoke("reviews:branchDiff", { chatId: panel.branchOf })
      : latis.invoke("reviews:diff", { reviewId: target });
    load
      .then((f) => {
        if (!live) return;
        setError(null);
        setFiles(f);
      })
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [panel.open, panel.branchOf, target]);

  const act = async (fn: () => Promise<ReviewItem>) => {
    try {
      updateReview(await fn());
    } catch (err) {
      toast(errorText(err));
    }
  };
  useEffect(() => {
    keys.current = {
      next: (d) => {
        if (!visible.length) return;
        const i = visible.findIndex((r) => r.id === current?.id);
        const n = visible[Math.min(visible.length - 1, Math.max(0, i + d))];
        if (n) openReview({ reviewId: n.id });
      },
      acceptAll: () => {
        if (current) void act(() => latis.invoke("reviews:accept", { reviewId: current.id }));
      },
      mark: () => {
        if (current) void act(() => latis.invoke("reviews:markReviewed", { reviewId: current.id, reviewed: current.reviewedAt === null }));
      },
    };
  });

  if (!panel.open) return null;
  const branchChat = panel.branchOf ? chats[panel.branchOf]?.summary : undefined;
  const openCount = reviews.filter((r) => r.reviewedAt === null).length;

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="fixed inset-0 z-40 flex flex-col bg-bg-0 outline-none"
      role="dialog"
      aria-label="Review"
      data-testid="review-panel"
    >
      <header
        className="drag-region flex h-11 shrink-0 items-center gap-3 border-b border-line px-4"
        style={{ paddingLeft: window.latis.platform === "darwin" ? 84 : 16 }}
      >
        <h2 className="text-[14px] font-semibold text-text-1">{branchChat ? `Changes on ${branchChat.worktree?.branch}` : "Review"}</h2>
        {!branchChat && <span className="text-[12px] text-text-3">{openCount} to review · ↑↓ items, A accept all, M mark reviewed</span>}
        <div className="no-drag ml-auto flex items-center gap-2">
          {!branchChat && (
            <>
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
                aria-label="Filter by project"
                className="h-7 rounded-control border border-line bg-surface px-2 text-[12px] text-text-1"
              >
                <option value="">All projects</option>
                {Object.values(projects).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                aria-label="Filter by agent"
                className="h-7 rounded-control border border-line bg-surface px-2 text-[12px] text-text-1"
              >
                <option value="">All agents</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-[12px] text-text-2">
                <input
                  type="checkbox"
                  checked={showReviewed}
                  onChange={(e) => setShowReviewed(e.target.checked)}
                  className="accent-[var(--accent)]"
                />{" "}
                Show reviewed
              </label>
            </>
          )}
          <div className="flex rounded-control border border-line" role="group" aria-label="Diff layout">
            <button
              aria-pressed={!split}
              onClick={() => setSplit(false)}
              className={cn("flex h-7 items-center gap-1 px-2 text-[12px]", !split ? "bg-surface-2 text-text-1" : "text-text-3")}
            >
              <Rows3 size={12} /> Unified
            </button>
            <button
              aria-pressed={split}
              onClick={() => setSplit(true)}
              className={cn("flex h-7 items-center gap-1 px-2 text-[12px]", split ? "bg-surface-2 text-text-1" : "text-text-3")}
              data-testid="split-toggle"
            >
              <Columns2 size={12} /> Split
            </button>
          </div>
          <Button variant="ghost" size="icon" aria-label="Close review" onClick={closeReview}>
            <X size={15} />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {!branchChat && (
          <nav className="w-80 shrink-0 overflow-y-auto border-r border-line p-2" aria-label="Review items">
            {visible.length === 0 && <p className="p-4 text-center text-[12px] text-text-3">No items.</p>}
            {visible.map((r) => {
              const c = chats[r.chatId]!.summary;
              const a = agents.find((x) => x.id === c.agentId);
              const add = r.files.reduce((s, f) => s + f.additions, 0);
              const del = r.files.reduce((s, f) => s + f.deletions, 0);
              return (
                <button
                  key={r.id}
                  onClick={() => openReview({ reviewId: r.id })}
                  className={cn(
                    "mb-1 w-full rounded-panel border p-2.5 text-left",
                    r.id === current?.id ? "border-line-strong bg-surface-2" : "border-transparent hover:bg-surface",
                    r.reviewedAt !== null && "opacity-60",
                  )}
                  data-testid="review-item"
                >
                  <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-1">
                    <span className="h-2 w-2 shrink-0" style={{ background: `var(--hue-${a?.hue ?? "violet"})` }} />
                    <span className="truncate">{c.title}</span>
                    {r.reviewedAt !== null && <CheckCheck size={12} className="ml-auto shrink-0 text-state-done" aria-label="Reviewed" />}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-text-2">{r.summary}</p>
                  <p className="mt-1 text-[11px] text-text-3">
                    {r.files.length} file{r.files.length === 1 ? "" : "s"} · <span className="text-state-done">+{add}</span>{" "}
                    <span className="text-state-error">−{del}</span>
                    {c.worktree && <span> · {c.worktree.branch}</span>}
                  </p>
                </button>
              );
            })}
          </nav>
        )}
        <main className="min-w-0 flex-1 overflow-y-auto p-4">
          {(current || branchChat) && (
            <div className="mb-3 flex items-center gap-2">
              {current && (
                <>
                  <p className="min-w-0 flex-1 truncate text-[13px] text-text-2">{current.summary}</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void act(() => latis.invoke("reviews:accept", { reviewId: current.id }))}
                    data-testid="accept-all"
                  >
                    <CheckCheck size={12} /> Accept all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(() => latis.invoke("reviews:markReviewed", { reviewId: current.id, reviewed: current.reviewedAt === null }))
                    }
                    data-testid="mark-reviewed"
                  >
                    {current.reviewedAt === null ? "Mark reviewed" : "Mark unreviewed"}
                  </Button>
                </>
              )}
              {(branchChat ?? (current && chats[current.chatId]?.summary))?.worktree?.removed === false && (
                <Button
                  size="sm"
                  variant="primary"
                  className="ml-auto"
                  onClick={() => {
                    const chatId = branchChat?.id ?? current!.chatId;
                    closeReview();
                    useWorkspace.setState({ mergeFor: chatId });
                  }}
                  data-testid="review-merge"
                >
                  <GitMerge size={12} /> Merge…
                </Button>
              )}
            </div>
          )}
          {!current && !branchChat && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center" data-testid="review-empty">
              <CheckCheck size={28} className="text-state-done" />
              <p className="text-[15px] font-medium text-text-1">All caught up</p>
              <p className="max-w-sm text-[13px] text-text-3">
                Every turn that changes files shows up here with its diff, so you can accept, revert or ask for changes.
              </p>
              <Button variant="secondary" onClick={closeReview}>
                Back to the canvas
              </Button>
            </div>
          )}
          {error && <p className="text-[13px] text-state-error">{error}</p>}
          {!error && files && (
            <div className="flex flex-col gap-3">
              {files.length === 0 && <p className="text-[13px] text-text-3">No changes.</p>}
              {files.map((f) => (
                <FileDiffView
                  key={f.path}
                  file={f}
                  split={split}
                  {...(current && { decisions: current.decisions[f.path] })}
                  actions={
                    current
                      ? {
                          accept: (hunk) =>
                            act(() =>
                              latis.invoke("reviews:accept", { reviewId: current.id, path: f.path, ...(hunk !== undefined && { hunk }) }),
                            ),
                          revert: (hunk) =>
                            act(() =>
                              latis.invoke("reviews:revert", { reviewId: current.id, path: f.path, ...(hunk !== undefined && { hunk }) }),
                            ),
                          ask: async (feedback, hunk) => {
                            await latis.invoke("reviews:askChanges", {
                              reviewId: current.id,
                              path: f.path,
                              feedback,
                              ...(hunk !== undefined && { hunk }),
                            });
                            toast("Sent to the chat.");
                          },
                        }
                      : {}
                  }
                />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
