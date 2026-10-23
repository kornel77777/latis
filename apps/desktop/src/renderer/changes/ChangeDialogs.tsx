import { useEffect, useState } from "react";
import { AlertTriangle, Check, FolderOpen, GitBranch, GitMerge, History, MessageSquare, RotateCcw, Undo2 } from "lucide-react";
import type { MergePreview } from "@latis/shared";
import { Button, Dialog, cn } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

/** §9.3 AC1: a second chat in a repo is offered its own worktree, on by default. */
export function IsolateDialog() {
  const offer = useWorkspace((s) => s.isolateOffer);
  const agent = useWorkspace((s) => s.agents.find((a) => a.id === offer?.agentId));
  const project = useWorkspace((s) => (offer ? s.projects[offer.projectId] : undefined));
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = () => useWorkspace.setState({ isolateOffer: null });
  const start = async () => {
    if (!offer) return;
    setBusy(true);
    await useWorkspace.getState().createChat({ agentId: offer.agentId, projectId: offer.projectId, isolate });
    setBusy(false);
    setIsolate(true);
    close();
  };
  return (
    <Dialog
      open={Boolean(offer)}
      onOpenChange={(o) => !o && close()}
      title={`New ${agent?.displayName ?? "agent"} chat in ${project?.name ?? "this project"}`}
    >
      <p className="text-[13px] leading-relaxed text-text-2">Another chat is already working in this repository.</p>
      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-panel border border-line p-3" data-testid="isolate-option">
        <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
        <span>
          <span className="flex items-center gap-1.5 text-[13px] text-text-1">
            <GitBranch size={13} /> Work in its own copy
          </span>
          <span className="block text-[12px] text-text-3">
            A git worktree on a new <code className="font-mono">latis/…</code> branch, so the two agents can't trip over each other. Review
            and merge it when it's done.
          </span>
        </span>
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void start()} disabled={busy} data-testid="isolate-start">
          Start chat
        </Button>
      </div>
    </Dialog>
  );
}

/** §9.3 AC4–AC5: dry-run merge, conflicts with ways out, then offer to remove the copy. */
export function MergeDialog() {
  const chatId = useWorkspace((s) => s.mergeFor);
  const chat = useWorkspace((s) => (chatId ? s.chats[chatId]?.summary : undefined));
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"merge" | "squash">("merge");
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState(false);
  const [unmerged, setUnmerged] = useState(0);
  const close = () => {
    useWorkspace.setState({ mergeFor: null });
    setPreview(null);
    setError(null);
    setMerged(false);
    setUnmerged(0);
  };

  useEffect(() => {
    if (!chatId) return;
    let live = true;
    latis
      .invoke("worktree:mergePreview", { chatId })
      .then((p) => live && setPreview(p))
      .catch((err: unknown) => live && setError(errorText(err)));
    return () => {
      live = false;
    };
  }, [chatId]);

  const doMerge = async () => {
    if (!chatId) return;
    setBusy(true);
    try {
      const r = await latis.invoke("worktree:merge", { chatId, mode });
      if (r.merged) setMerged(true);
      else setPreview((p) => (p ? { ...p, conflicts: r.conflicts } : p));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (force: boolean) => {
    if (!chatId) return;
    setBusy(true);
    try {
      const r = await latis.invoke("worktree:remove", { chatId, force });
      if (r.removed) {
        useWorkspace.getState().toast("The copy is removed. The chat works in the project folder now.");
        close();
      } else setUnmerged(r.unmerged);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const wt = chat?.worktree;
  return (
    <Dialog open={Boolean(chatId)} onOpenChange={(o) => !o && close()} title={merged ? "Merged" : `Merge ${wt?.branch ?? ""}`} width={540}>
      <div className="text-[13px] text-text-2" data-testid="merge-dialog">
        {error && (
          <p className="mb-3 rounded-control border border-state-error/30 bg-state-error/10 px-3 py-2 text-state-error" role="alert">
            {error}
          </p>
        )}
        {!preview && !error && <div className="h-16 animate-pulse rounded-panel bg-surface-2" aria-label="Checking the merge" />}
        {preview && !merged && (
          <>
            <p>
              {preview.ahead === 0 ? (
                <>
                  Nothing to merge: <code className="font-mono">{preview.branch}</code> has no changes that{" "}
                  <code className="font-mono">{preview.baseRef}</code> doesn't.
                </>
              ) : (
                <>
                  {preview.ahead} commit{preview.ahead === 1 ? "" : "s"} from <code className="font-mono">{preview.branch}</code> into{" "}
                  <code className="font-mono">{preview.baseRef}</code> in the project folder.
                </>
              )}
            </p>
            {preview.blocker && (
              <p className="mt-3 flex gap-2 rounded-control border border-state-working/40 bg-state-working/10 px-3 py-2 text-text-1">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-state-working" /> {preview.blocker}
              </p>
            )}
            {preview.conflicts.length > 0 ? (
              <div className="mt-3 rounded-control border border-state-error/40 p-3" data-testid="merge-conflicts">
                <p className="font-medium text-text-1">These files conflict with {preview.baseRef}:</p>
                <ul className="mt-1 font-mono text-[12px] text-text-1">
                  {preview.conflicts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                      // Close first: the agent's reply shows in the chat, and the canvas shouldn't stay blocked meanwhile.
                      const id = chatId!;
                      const files = preview.conflicts;
                      close();
                      void latis
                        .invoke("worktree:askResolve", { chatId: id, files })
                        .catch((err: unknown) => useWorkspace.getState().toast(errorText(err)));
                    }}
                    data-testid="ask-resolve"
                  >
                    <MessageSquare size={12} /> Ask the agent to resolve
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => void useWorkspace.getState().reveal(chatId!)}>
                    <FolderOpen size={12} /> Open the copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={close}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {preview.ahead > 0 && !preview.blocker && (
                  <p className="mt-3 flex items-center gap-1.5 text-state-done">
                    <Check size={13} /> No conflicts (checked with a dry run).
                  </p>
                )}
                <fieldset className="mt-3 flex gap-4">
                  {(["merge", "squash"] as const).map((m) => (
                    <label key={m} className="flex cursor-pointer items-center gap-1.5 text-text-1">
                      <input
                        type="radio"
                        name="merge-mode"
                        checked={mode === m}
                        onChange={() => setMode(m)}
                        className="accent-[var(--accent)]"
                      />
                      {m === "merge" ? "Merge commit" : "Squash into one commit"}
                    </label>
                  ))}
                </fieldset>
                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="ghost" onClick={close}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || Boolean(preview.blocker) || preview.ahead === 0}
                    onClick={() => void doMerge()}
                    data-testid="merge-confirm"
                  >
                    <GitMerge size={13} /> Merge into {preview.baseRef}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        {(merged || (preview && preview.ahead === 0 && !preview.conflicts.length)) && (
          <div className="mt-1">
            {merged && <p className="text-text-1">The changes are in {preview?.baseRef}. Remove the copy and its branch?</p>}
            {unmerged > 0 && (
              <p className="mt-2 text-state-error">
                The branch still has {unmerged} commit{unmerged === 1 ? "" : "s"} that aren't in {preview?.baseRef}. Removing deletes them.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Keep it
              </Button>
              <Button
                variant={unmerged ? "danger" : "secondary"}
                disabled={busy}
                onClick={() => void remove(unmerged > 0)}
                data-testid="remove-worktree"
              >
                {unmerged ? "Delete unmerged work and remove" : "Remove copy"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** §9.4 AC3: turns with the files they changed; undo/redo one, or restore to before any of them. */
export function TimelineDialog() {
  const chatId = useWorkspace((s) => s.timelineFor);
  const entries = useWorkspace((s) => (chatId ? s.timelines[chatId] : undefined));
  const title = useWorkspace((s) => (chatId ? s.chats[chatId]?.summary.title : ""));
  const { undoTurn, redoTurn, restoreTo, loadTimeline } = useWorkspace.getState();
  useEffect(() => {
    if (chatId) void loadTimeline(chatId);
  }, [chatId, loadTimeline]);
  const close = () => useWorkspace.setState({ timelineFor: null });
  return (
    <Dialog open={Boolean(chatId)} onOpenChange={(o) => !o && close()} title={`Timeline · ${title ?? ""}`} width={600}>
      <ol className="flex flex-col gap-1.5" data-testid="timeline">
        {(entries ?? []).map((e) => (
          <li
            key={e.turnId}
            className={cn("rounded-panel border border-line p-2.5", e.undone && "opacity-60")}
            data-testid="timeline-entry"
          >
            <div className="flex items-center gap-2 text-[13px]">
              <History size={13} className="shrink-0 text-text-3" />
              <span className="min-w-0 flex-1 truncate text-text-1">{e.userText}</span>
              <span className="shrink-0 text-[11px] text-text-3">
                {new Date(e.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {e.files.length > 0 && <div className="mt-1 truncate pl-5 font-mono text-[11px] text-text-3">{e.files.join(", ")}</div>}
            {e.restorable && e.files.length > 0 && (
              <div className="mt-1.5 flex gap-1 pl-4">
                {e.undone ? (
                  <Button size="sm" variant="ghost" onClick={() => void redoTurn(chatId!, e.turnId)}>
                    <RotateCcw size={12} /> Redo
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void undoTurn(chatId!, e.turnId)}>
                    <Undo2 size={12} /> Undo this turn
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => void restoreTo(chatId!, e.turnId)} data-testid="restore-to">
                  <History size={12} /> Restore to before this turn
                </Button>
              </div>
            )}
          </li>
        ))}
        {entries?.length === 0 && <p className="text-[13px] text-text-3">No turns yet.</p>}
        {entries && entries.length > 0 && entries.every((e) => !e.restorable) && (
          <p className="text-[12px] text-text-3">Checkpoints need the project to be a git repository.</p>
        )}
      </ol>
    </Dialog>
  );
}
