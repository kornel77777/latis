import { memo, useEffect, useMemo, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  AlarmClock,
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CornerDownRight,
  Network,
  Pin,
  Plug,
  Settings2,
  Folder,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitMerge,
  History,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Send,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import type { ImageAttachment, QueuedMessage } from "@latis/shared";
import { buildTranscript } from "@latis/shared";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, StatusDot, cn } from "@latis/ui";
import { useZoomLevel } from "../canvas/zoom";
import { useWorkspace, type FlowNode } from "../stores/workspace";
import { ChatCondensed, ChatTile } from "./ChatCompact";
import { Item, type ItemActions } from "./items";
import { ModelPicker, PermissionPicker, ReasoningPicker } from "./pickers";
import { ChatJob, FlowHandles } from "../canvas/flows";
import { LimitBanner, ScheduledList, SendLaterDialog } from "./Later";
import { SkillSuggestions, useSkillSuggestions } from "./SkillSuggestions";
import { TerminalChatBody } from "./TerminalChatBody";

/** Things to ask the Conductor, shown while it has no messages (§10.2). */
const CONDUCTOR_STARTERS = [
  "Have three agents each review the auth module from different angles and summarise where they agree.",
  "Which chats are done? Summarise what each changed.",
  "Tidy my canvas.",
];

const FALLBACK_HUE: Record<string, string> = { "claude-code": "amber-sand", codex: "slate-blue", gemini: "sky", fake: "violet" };

/** A chat on the canvas: full card, condensed card or status tile depending on zoom (§8.4). */
export const ChatNode = memo(function ChatNode({ id, data, selected }: NodeProps<FlowNode>) {
  const level = useZoomLevel();
  const chatId = data.chatId ?? "";
  const body =
    level === "tile" ? (
      <ChatTile chatId={chatId} selected={selected} />
    ) : level === "condensed" ? (
      <ChatCondensed chatId={chatId} selected={selected} />
    ) : (
      <FullChat chatId={chatId} selected={selected} />
    );
  return (
    <>
      {body}
      <FlowHandles nodeId={id} />
    </>
  );
});

/** The full chat card; also used outside the canvas by focus mode (`inCanvas={false}`). */
export const FullChat = memo(function FullChat({
  chatId,
  selected,
  inCanvas = true,
  paneControls,
  paneGrip,
  onHeaderPointerDown,
}: {
  chatId: string;
  selected: boolean;
  inCanvas?: boolean;
  /** Extra header buttons (the lattice's maximise / take out). */
  paneControls?: React.ReactNode;
  /** A drag handle at the start of the header (the lattice). */
  paneGrip?: React.ReactNode;
  /** The lattice drags panes by their header. */
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
}) {
  const chat = useWorkspace((s) => s.chats[chatId]);
  const agent = useWorkspace((s) => s.agents.find((a) => a.id === chat?.summary.agentId));
  const queue = useWorkspace((s) => s.queues[chatId]);
  const timeline = useWorkspace((s) => s.timelines[chatId]);
  const { send, steer, respond, interrupt, restart, setChatOptions, reveal, openAsTerminal, markSeen } = useWorkspace.getState();
  const items = useMemo(() => (chat ? buildTranscript(chat.turns, chat.events) : []), [chat]);
  // Drafts live in the store so they survive the card unmounting (zoom, off-screen virtualisation).
  // Draft and images live in the store: they survive unmounting, and the element picker can add to them.
  const draft = useWorkspace((st) => st.drafts[chatId] ?? "");
  const images = useWorkspace((st) => st.attachments[chatId]);
  const setDraft = (text: string) => {
    useWorkspace.setState((st) => ({ drafts: { ...st.drafts, [chatId]: text } }));
  };
  const [editingTitle, setEditingTitle] = useState(false);
  const list = useRef<VirtuosoHandle>(null);
  const connections = useWorkspace((st) => st.connections);
  const suggest = useSkillSuggestions(draft, chat?.summary.projectId ?? null);
  const [later, setLater] = useState(false);
  const continuedFrom = useWorkspace((st) => {
    const id = st.chats[chatId]?.summary.continuedFrom;
    return id ? (st.chats[id]?.summary.title ?? "a deleted chat") : null;
  });

  const actions = useMemo<ItemActions>(
    () => ({
      respond: (requestId, response) => void respond(chatId, requestId, response),
      openPath: (path) => void reveal(chatId, path),
      turnState: (turnId) => {
        const e = timeline?.find((t) => t.turnId === turnId);
        return e && { files: e.files.length, undone: e.undone, restorable: e.restorable };
      },
      undo: (turnId) => void useWorkspace.getState().undoTurn(chatId, turnId),
      redo: (turnId) => void useWorkspace.getState().redoTurn(chatId, turnId),
    }),
    [chatId, respond, reveal, timeline],
  );

  // New chats (and keyboard jumps) put the cursor in the composer.
  const wantsFocus = useWorkspace((st) => st.focusComposer === chatId);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!wantsFocus) return;
    const t = setTimeout(() => {
      composerRef.current?.focus();
      useWorkspace.setState({ focusComposer: null });
    }, 350); // after the canvas has panned to the new chat
    return () => clearTimeout(t);
  }, [wantsFocus]);

  // Looking at a chat clears its "finished" Inbox item (§8.6).
  useEffect(() => {
    if (selected) markSeen(chatId);
  }, [selected, chatId, markSeen, chat?.summary.status]);

  if (!chat) {
    return <div className="h-full w-full rounded-card border border-line bg-surface p-4 text-text-3">Chat not found.</div>;
  }
  const s = chat.summary;
  const working = s.status === "working" || s.status === "needs-you";
  const hue = agent?.hue ?? FALLBACK_HUE[s.agentId] ?? "violet";
  const agentLabel = agent?.displayName ?? (s.agentId === "fake" ? "Demo agent" : s.agentId);
  const folder = s.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? s.cwd;
  const terminalAgent = agent?.kind === "terminal";
  const unenforced = !terminalAgent && s.permissionMode === "full-auto" && (agent?.unenforceable ?? []).includes("full-auto");
  const conductor = s.role === "conductor";
  const ownConnections = connections.filter((c) => !c.shared);

  const setImages = (list: ImageAttachment[]) => useWorkspace.setState((st) => ({ attachments: { ...st.attachments, [chatId]: list } }));
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    const attached = images ?? [];
    setDraft("");
    setImages([]);
    // Mid-turn messages steer the agent or wait in the queue (§9.9).
    const sent = working ? steer(chatId, text, attached) : send(chatId, text, attached);
    void sent.then(() => list.current?.scrollToIndex({ index: "LAST", behavior: "auto" }));
  };

  return (
    <>
      {inCanvas && <NodeResizer isVisible={selected} minWidth={360} minHeight={300} />}
      <article
        aria-label={`Chat: ${s.title}`}
        data-testid="chat-card"
        data-chat-id={chatId}
        data-status={s.status}
        data-agent={s.agentId}
        data-completed-turns={items.filter((i) => i.kind === "turn-end").length}
        className={cn(
          "flex h-full w-full flex-col overflow-hidden rounded-card border bg-surface transition-shadow duration-fast",
          selected ? "border-line-strong shadow-lift" : "border-line",
          s.status === "needs-you" && "ring-1 ring-state-needs-you/50",
        )}
        style={{ borderTop: `2px solid var(--hue-${hue})` }}
      >
        <header
          className="latis-drag flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line px-3 active:cursor-grabbing"
          {...(onHeaderPointerDown && { onPointerDown: onHeaderPointerDown })}
        >
          {paneGrip}
          <StatusDot status={s.status} />
          {conductor && (
            <span title="The Conductor is pinned here and can't be deleted." className="text-accent" data-testid="conductor-badge">
              <Pin size={12} />
            </span>
          )}
          {!conductor && s.workspaceTools && (
            <span title="Has the workspace tools: can see and start other chats." className="text-accent">
              <Network size={12} />
            </span>
          )}
          {editingTitle ? (
            <input
              autoFocus
              defaultValue={s.title}
              aria-label="Chat title"
              className="nodrag min-w-0 flex-1 rounded-[6px] border border-line-strong bg-bg-1 px-1.5 text-[13px] font-semibold text-text-1 outline-none"
              onBlur={(e) => {
                setEditingTitle(false);
                const t = e.currentTarget.value.trim();
                if (t && t !== s.title) void setChatOptions(chatId, { title: t });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditingTitle(false);
              }}
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-1"
              onDoubleClick={() => setEditingTitle(true)}
              data-testid="chat-title"
            >
              {s.title}
            </span>
          )}
          <div className="nodrag flex shrink-0 items-center gap-0.5">
            {terminalAgent ? (
              <span className="px-1.5 text-[11.5px] text-text-3">{agentLabel} · terminal</span>
            ) : (
              <ModelPicker chat={s} agentLabel={agentLabel} />
            )}
            {unenforced && (
              <span
                title={`Full-auto: ${agentLabel} runs every tool without asking, and Latis can't enforce the always-ask list yet.`}
                className="text-state-working"
              >
                <AlertTriangle size={13} />
              </span>
            )}
            {s.worktree && !s.worktree.removed ? (
              <Menu
                trigger={
                  <button
                    className="flex h-6 max-w-36 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] text-accent hover:bg-surface-2"
                    title={`Own copy: ${s.worktree.path}`}
                    aria-label={`Branch ${s.worktree.branch}`}
                    data-testid="branch-chip"
                  >
                    <GitBranch size={12} className="shrink-0" />{" "}
                    <span className="truncate">{s.worktree.branch.replace(/^latis\//, "")}</span>
                    {s.worktree.merged && <span className="text-text-3">· merged</span>}
                  </button>
                }
              >
                <MenuItem onSelect={() => useWorkspace.getState().openReview({ branchOf: chatId })}>
                  <GitCompare size={13} /> Review changes…
                </MenuItem>
                <MenuItem onSelect={() => useWorkspace.setState({ mergeFor: chatId })}>
                  <GitMerge size={13} /> Merge into {s.worktree.baseRef}…
                </MenuItem>
                <MenuItem onSelect={() => void reveal(chatId)}>
                  <FolderOpen size={13} /> Open the copy
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => useWorkspace.setState({ mergeFor: chatId })}>
                  <Trash2 size={13} /> Remove copy…
                </MenuItem>
              </Menu>
            ) : (
              <Menu
                trigger={
                  <button
                    className="flex h-6 max-w-28 items-center gap-1 rounded-[6px] px-1.5 text-[11.5px] text-text-3 hover:bg-surface-2 hover:text-text-1"
                    title={s.cwd}
                    aria-label={`Folder ${folder}`}
                    data-testid="folder-chip"
                  >
                    <Folder size={12} className="shrink-0" /> <span className="truncate">{folder}</span>
                  </button>
                }
              >
                <MenuItem onSelect={() => void reveal(chatId)}>
                  <FolderOpen size={13} /> Reveal folder
                </MenuItem>
                {s.projectId && !terminalAgent && (
                  <MenuItem
                    onSelect={() =>
                      void window.latis
                        .invoke("chat:isolate", { chatId })
                        .then(() => useWorkspace.getState().toast("This chat now works in its own copy on a new branch."))
                        .catch((err: unknown) => useWorkspace.getState().toast(err instanceof Error ? err.message : String(err)))
                    }
                  >
                    <GitBranch size={13} /> Work in its own copy
                  </MenuItem>
                )}
              </Menu>
            )}
            {paneControls}
            <Menu
              trigger={
                <Button variant="ghost" size="icon" aria-label="Chat menu">
                  <MoreHorizontal size={15} />
                </Button>
              }
            >
              <MenuItem onSelect={() => setEditingTitle(true)}>
                <Pencil size={13} /> Rename
              </MenuItem>
              <MenuItem onSelect={() => void reveal(chatId)}>
                <FolderOpen size={13} /> Open folder
              </MenuItem>
              {!terminalAgent && (
                <MenuItem onSelect={() => useWorkspace.setState({ timelineFor: chatId })}>
                  <History size={13} /> Timeline
                </MenuItem>
              )}
              {!terminalAgent && s.agentId !== "fake" && (
                <MenuItem onSelect={() => void openAsTerminal(chatId)}>
                  <SquareTerminal size={13} /> Open as terminal
                </MenuItem>
              )}
              {conductor ? (
                <MenuItem onSelect={() => useWorkspace.getState().setSettingsOpen(true, "Conductor")}>
                  <Settings2 size={13} /> Conductor settings…
                </MenuItem>
              ) : (
                !terminalAgent &&
                s.agentId !== "fake" && (
                  <MenuItem onSelect={() => void useWorkspace.getState().setWorkspaceTools(chatId, !s.workspaceTools)}>
                    <Network size={13} /> {s.workspaceTools ? "Remove workspace tools" : "Give workspace tools"}
                  </MenuItem>
                )
              )}
              {!terminalAgent && ownConnections.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuLabel>Connections for this chat</MenuLabel>
                  {ownConnections.map((c) => {
                    const on = s.connections.includes(c.id);
                    return (
                      <MenuItem
                        key={c.id}
                        onSelect={() =>
                          void useWorkspace
                            .getState()
                            .setConnections(chatId, on ? s.connections.filter((x) => x !== c.id) : [...s.connections, c.id])
                        }
                      >
                        {on ? <Check size={13} /> : <Plug size={13} />} {c.name}
                      </MenuItem>
                    );
                  })}
                </>
              )}
              <MenuSeparator />
              <MenuItem onSelect={() => void restart(chatId)}>
                <RotateCcw size={13} /> Restart agent
              </MenuItem>
            </Menu>
          </div>
        </header>

        {inCanvas && <ChatJob nodeId={s.nodeId} />}
        {s.continuedFrom && (
          <button
            className="nodrag flex shrink-0 items-center gap-1.5 border-b border-line bg-bg-1 px-3 py-1 text-left text-[11.5px] text-text-3 hover:text-text-1"
            onClick={() => useWorkspace.getState().focusChat(s.continuedFrom!)}
            data-testid="continued-from"
          >
            <ArrowRightLeft size={11} /> Continued from {continuedFrom}
          </button>
        )}
        {terminalAgent ? (
          <TerminalChatBody chatId={chatId} />
        ) : (
          <>
            <div
              className="nowheel nodrag selectable min-h-0 flex-1 cursor-auto leading-relaxed"
              style={{ fontSize: "var(--chat-text, 14px)" }}
              data-testid="transcript"
            >
              {chat.loaded && items.length === 0 ? (
                <p className="px-3.5 py-3 text-[13px] text-text-3">
                  {conductor ? (
                    <span className="flex flex-col gap-2" data-testid="conductor-intro">
                      <span>
                        I&apos;m the Conductor. I can start chats with any of your agents, wait for them, read what they did and put the
                        results on the canvas. Try:
                      </span>
                      {CONDUCTOR_STARTERS.map((t) => (
                        <button
                          key={t}
                          className="rounded-control border border-line px-2.5 py-1.5 text-left text-text-2 hover:border-line-strong hover:text-text-1"
                          onClick={() => {
                            setDraft(t);
                            composerRef.current?.focus();
                          }}
                        >
                          {t}
                        </button>
                      ))}
                    </span>
                  ) : s.agentId === "fake" ? (
                    <>
                      Say anything to start. Include <code className="font-mono text-text-2">/crash</code> to see how a crashed agent is
                      handled.
                    </>
                  ) : (
                    <>
                      {agentLabel} works in <span className="font-mono text-text-2">{folder}</span>. Ask for a change, a review or an
                      explanation.
                    </>
                  )}
                </p>
              ) : (
                <Virtuoso
                  ref={list}
                  className="scroll-thin"
                  data={items}
                  followOutput={(atBottom) => (atBottom ? "auto" : false)}
                  initialTopMostItemIndex={Math.max(0, items.length - 1)}
                  increaseViewportBy={{ top: 400, bottom: 400 }}
                  computeItemKey={(_i, it) => it.key}
                  itemContent={(_i, it) => (
                    <div className="latis-item px-3.5 py-1.25">
                      <Item item={it} actions={actions} />
                    </div>
                  )}
                  components={{
                    Header: () => <div className="h-2" />,
                    Footer: () =>
                      s.status === "error" ? (
                        <div className="mx-3.5 mb-2 mt-1 flex items-center gap-2 rounded-control border border-state-error/30 bg-state-error/10 px-3 py-2 text-[13px]">
                          <span className="text-text-1">The agent stopped unexpectedly.</span>
                          <Button size="sm" variant="danger" className="ml-auto" onClick={() => void restart(chatId)} data-testid="restart">
                            <RotateCcw size={12} /> Restart
                          </Button>
                        </div>
                      ) : (
                        <div className="h-2" />
                      ),
                  }}
                />
              )}
            </div>

            <footer className="nodrag shrink-0 border-t border-line p-2">
              <LimitBanner chatId={chatId} />
              <ScheduledList chatId={chatId} />
              {queue && queue.length > 0 && <QueueList chatId={chatId} queue={queue} />}
              <SkillSuggestions matches={suggest.matches} index={suggest.index} onPick={(sk) => setDraft(suggest.pick(sk))} />
              <div className="rounded-control border border-line bg-bg-1 focus-within:border-line-strong">
                {images && images.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-2 pt-2" aria-label="Attached images" data-testid="attachments">
                    {images.map((img, i) => (
                      <div key={i} className="group relative h-12 w-16 overflow-hidden rounded-[6px] border border-line">
                        <img
                          src={`data:${img.mime};base64,${img.dataBase64}`}
                          alt={`Attachment ${i + 1}`}
                          className="h-full w-full object-cover"
                        />
                        <button
                          aria-label={`Remove attachment ${i + 1}`}
                          className="absolute right-0.5 top-0.5 rounded bg-bg-0/80 p-0.5 text-text-1 opacity-0 group-hover:opacity-100"
                          onClick={() => setImages(images.filter((_, j) => j !== i))}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={(e) => {
                    // Pasted images become attachments (§8.5).
                    const files = [...e.clipboardData.files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
                    if (!files.length) return;
                    e.preventDefault();
                    void Promise.all(files.map(readImage)).then((list) => setImages([...(images ?? []), ...list]));
                  }}
                  onKeyDown={(e) => {
                    const picked = suggest.onKey(e);
                    if (picked !== undefined) {
                      if (picked !== null) setDraft(picked);
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  rows={2}
                  placeholder={
                    working
                      ? agent?.steering
                        ? "Steer: reaches the agent at its next step…"
                        : "Queue a message for when this turn ends…"
                      : conductor
                        ? "Ask the Conductor to coordinate your chats…"
                        : `Ask ${agentLabel}…`
                  }
                  aria-label="Message"
                  data-testid="composer"
                  className="block max-h-40 min-h-11 w-full resize-none bg-transparent px-2.5 pt-2 text-[13px] text-text-1 outline-none placeholder:text-text-3"
                />
                <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                  {s.agentId !== "fake" && (
                    <>
                      <PermissionPicker chat={s} unenforceable={agent?.unenforceable ?? []} />
                      <ReasoningPicker chat={s} />
                    </>
                  )}
                  <div className="flex-1" />
                  {working && (
                    <Button size="icon" variant="secondary" aria-label="Stop" onClick={() => void interrupt(chatId)} data-testid="stop">
                      <Square size={12} />
                    </Button>
                  )}
                  {draft.trim() && (
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Send later"
                      title="Send later"
                      onClick={() => setLater(true)}
                      data-testid="send-later"
                    >
                      <AlarmClock size={13} />
                    </Button>
                  )}
                  {(!working || draft.trim()) && (
                    <Button
                      size="icon"
                      variant="primary"
                      onContextMenu={(e) => {
                        // Right-click Send → Send later (§9.10 AC1).
                        e.preventDefault();
                        if (draft.trim()) setLater(true);
                      }}
                      aria-label={working ? (agent?.steering ? "Steer" : "Queue") : "Send"}
                      onClick={submit}
                      disabled={!draft.trim()}
                      data-testid="send"
                    >
                      <Send size={13} />
                    </Button>
                  )}
                </div>
              </div>
            </footer>
            {later && (
              <SendLaterDialog
                chatId={chatId}
                text={draft.trim()}
                open={later}
                onClose={(sent) => {
                  setLater(false);
                  if (sent) setDraft("");
                }}
              />
            )}
          </>
        )}
      </article>
    </>
  );
});

function readImage(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ mime: file.type as ImageAttachment["mime"], dataBase64: String(r.result).split(",")[1] ?? "" });
    r.onerror = () => reject(r.error ?? new Error("couldn't read the image"));
    r.readAsDataURL(file);
  });
}

/** Messages waiting for the turn to end, pinned above the composer (§9.9 AC1, AC3). */
function QueueList({ chatId, queue }: { chatId: string; queue: QueuedMessage[] }) {
  const { editQueued, removeQueued, sendNow } = useWorkspace.getState();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <ul className="mb-1.5 flex flex-col gap-1" aria-label="Next steps" data-testid="queue">
      {queue.map((q) => (
        <li
          key={q.id}
          className="group flex items-start gap-1.5 rounded-control border border-dashed border-line bg-bg-1 px-2 py-1.5 text-[12.5px]"
        >
          <CornerDownRight size={12} className="mt-0.5 shrink-0 text-text-3" />
          <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-3">Next step</span>
          {editing === q.id ? (
            <input
              autoFocus
              defaultValue={q.text}
              aria-label="Edit queued message"
              className="min-w-0 flex-1 bg-transparent text-text-1 outline-none"
              onBlur={(e) => {
                setEditing(null);
                const t = e.currentTarget.value.trim();
                if (t && t !== q.text) void editQueued(chatId, q.id, t);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") setEditing(null);
              }}
            />
          ) : (
            <button
              className="min-w-0 flex-1 truncate text-left text-text-1"
              onClick={() => setEditing(q.id)}
              title="Edit"
              data-testid="queued-text"
            >
              {q.text}
            </button>
          )}
          <button
            className="shrink-0 rounded px-1 text-[11px] text-accent hover:underline"
            onClick={() => void sendNow(chatId, q.id)}
            data-testid="send-now"
          >
            Send now
          </button>
          <button
            aria-label="Remove queued message"
            className="shrink-0 rounded p-0.5 text-text-3 hover:text-text-1"
            onClick={() => void removeQueued(chatId, q.id)}
          >
            <X size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
