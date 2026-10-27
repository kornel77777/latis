import { useEffect, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  FileText,
  Grid2x2,
  Plus,
  ScanSearch,
  FolderOpen,
  FolderTree,
  GitCompare,
  Inbox,
  LayoutGrid,
  MessageCircleQuestion,
  ScrollText,
  ShieldQuestion,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import type { AttentionItem, ChatSummary } from "@latis/shared";
import { latis } from "../api";
import { runCommand } from "../commands/registry";
import { Button, StatusDot, cn } from "@latis/ui";
import { useShallow } from "zustand/react/shallow";
import { PROJECT_COLORS } from "../canvas/ProjectFrame";
import { useCanvasActions } from "../canvas/useCanvasActions";
import { useWorkspace } from "../stores/workspace";

const tabs = [
  { id: "projects", label: "Projects", icon: LayoutGrid },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "inbox", label: "Inbox", icon: Inbox },
] as const;

export function Sidebar() {
  const [files, setFiles] = useState(false);
  const storeTab = useWorkspace((s) => s.sidebarTab);
  const setStoreTab = useWorkspace((s) => s.setSidebarTab);
  const inboxCount = useWorkspace((s) => s.attention.length);
  const tab = files ? "files" : storeTab;
  const setTab = (t: (typeof tabs)[number]["id"]) => {
    setFiles(t === "files");
    if (t !== "files") setStoreTab(t);
  };
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-bg-0" aria-label="Sidebar">
      <div role="tablist" className="flex gap-0.5 border-b border-line p-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center gap-1.5 rounded-control text-[12px] font-medium transition-colors duration-fast",
              tab === t.id ? "bg-surface-2 text-text-1" : "text-text-3 hover:text-text-2",
            )}
          >
            <t.icon size={13} /> {t.label}
            {t.id === "inbox" && inboxCount > 0 && (
              <span
                className="rounded-control bg-state-needs-you px-1.5 text-[10px] font-semibold leading-4 text-bg-0"
                data-testid="inbox-count"
              >
                {inboxCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <ReviewEntry />
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tab === "projects" && <ProjectsTab />}
        {tab === "files" && <FilesTab />}
        {tab === "inbox" && <InboxTab />}
      </div>
    </aside>
  );
}

/** §9.5 AC5: the Review Inbox count, one click from anywhere. */
function ReviewEntry() {
  const open = useWorkspace((s) => s.reviews.filter((r) => r.reviewedAt === null).length);
  const openReview = useWorkspace((s) => s.openReview);
  return (
    <button
      onClick={() => openReview()}
      className="mx-1.5 mt-1.5 flex h-8 items-center gap-2 rounded-control px-2 text-left text-[12.5px] text-text-2 hover:bg-surface-2 hover:text-text-1"
      title="Review changes (Ctrl+Shift+R)"
      data-testid="open-review"
    >
      <GitCompare size={13} /> Review changes
      {open > 0 && (
        <span
          className="ml-auto rounded-control bg-accent px-1.5 text-[10px] font-semibold leading-4 text-accent-fg"
          data-testid="review-count"
        >
          {open}
        </span>
      )}
    </button>
  );
}

const KIND_ICON: Record<AttentionItem["kind"], typeof Check> = {
  permission: ShieldQuestion,
  question: MessageCircleQuestion,
  plan: ScrollText,
  finished: Check,
  error: CircleAlert,
  rate_limited: Timer,
};

/** Attention queue (§8.6): newest first, grouped by project, with inline answers for approvals. */
function InboxTab() {
  const items = useWorkspace(useShallow((s) => s.attention));
  const chats = useWorkspace((s) => s.chats);
  const projects = useWorkspace((s) => s.projects);
  if (!items.length) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-[12px] leading-relaxed text-text-3" data-testid="inbox-empty">
        <Inbox size={20} />
        Nothing needs you. Approvals, questions and finished chats land here.
        <span className="text-text-3">Ctrl+J jumps to the next one.</span>
      </div>
    );
  }
  const groups = new Map<string, AttentionItem[]>();
  for (const it of items) {
    const pid = chats[it.chatId]?.summary.projectId ?? "";
    groups.set(pid, [...(groups.get(pid) ?? []), it]);
  }
  return (
    <div className="p-1.5" aria-live="polite">
      {[...groups].map(([pid, list]) => (
        <section key={pid || "none"} className="mb-2">
          <h3 className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">{projects[pid]?.name ?? "Other"}</h3>
          {list.map((it) => (
            <InboxRow key={it.id} item={it} chatTitle={chats[it.chatId]?.summary.title ?? "Chat"} />
          ))}
        </section>
      ))}
    </div>
  );
}

function InboxRow({ item, chatTitle }: { item: AttentionItem; chatTitle: string }) {
  const { focusChat, respond, dismissAttention } = useWorkspace(
    useShallow((s) => ({ focusChat: s.focusChat, respond: s.respond, dismissAttention: s.dismissAttention })),
  );
  const Icon = KIND_ICON[item.kind];
  const needsYou = item.kind === "permission" || item.kind === "question" || item.kind === "plan" || item.kind === "rate_limited";
  const answerable = item.kind === "permission" && item.refId !== null;
  return (
    <div className="group rounded-control px-2 py-1.5 hover:bg-surface-2" data-testid="inbox-item" data-kind={item.kind}>
      <button className="flex w-full items-start gap-2 text-left" onClick={() => focusChat(item.chatId)}>
        <Icon
          size={13}
          className={cn(
            "mt-0.5 shrink-0",
            needsYou ? "text-state-needs-you" : item.kind === "error" ? "text-state-error" : "text-state-done",
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-text-1">
            {item.kind === "finished" ? item.summary : `${chatTitle}: ${item.summary}`}
          </span>
          {item.detail && <span className="block truncate font-mono text-[11px] text-text-3">{item.detail}</span>}
        </span>
      </button>
      <div className="mt-1 flex gap-1 pl-5">
        {answerable ? (
          <>
            <button
              className="h-6 rounded-control bg-accent px-2 text-[11px] font-medium text-accent-fg hover:opacity-90"
              onClick={() => void respond(item.chatId, item.refId!, { kind: "permission", decision: "allow-once" })}
            >
              Allow
            </button>
            <button
              className="h-6 rounded-control px-2 text-[11px] text-text-2 hover:bg-surface hover:text-text-1"
              onClick={() => void respond(item.chatId, item.refId!, { kind: "permission", decision: "deny" })}
            >
              Deny
            </button>
          </>
        ) : (
          <button
            className="h-6 rounded-control px-2 text-[11px] text-text-2 hover:bg-surface hover:text-text-1"
            onClick={() => focusChat(item.chatId)}
          >
            {needsYou ? "Answer" : "Open"}
          </button>
        )}
        {!needsYou && (
          <button
            aria-label="Dismiss"
            className="ml-auto rounded-[2px] p-1 text-text-3 opacity-0 hover:text-text-1 group-hover:opacity-100"
            onClick={() => void dismissAttention(item.id)}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

const FALLBACK_HUE: Record<string, string> = { "claude-code": "amber-sand", codex: "slate-blue", gemini: "sky", fake: "violet" };

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-2">
      <div className="flex h-7 items-center px-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-text-3">
        {title}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

function ChatRow({ chat, indent }: { chat: ChatSummary; indent: boolean }) {
  const hue = useWorkspace((s) => s.agents.find((a) => a.id === chat.agentId)?.hue ?? FALLBACK_HUE[chat.agentId] ?? "violet");
  return (
    <div
      className={cn(
        "group flex h-7 w-full items-center rounded-control pr-1 text-[12px] text-text-2 hover:bg-surface-2 hover:text-text-1",
        indent ? "pl-7" : "pl-2",
      )}
      data-testid="sidebar-chat"
    >
      <button
        onClick={() => useWorkspace.getState().focusChat(chat.id)}
        className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
      >
        <span className="h-3 w-[3px] shrink-0" style={{ background: `var(--hue-${hue})` }} />
        <span className="min-w-0 flex-1 truncate">{chat.title}</span>
      </button>
      {chat.role !== "conductor" && (
        <button
          onClick={() => void useWorkspace.getState().deleteChat(chat.id)}
          aria-label={`Delete ${chat.title}`}
          title="Delete chat (undo, or restore from ⌘K for 7 days)"
          className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-control text-text-3 hover:bg-bg-1 hover:text-state-error focus-visible:flex group-hover:flex"
          data-testid="sidebar-chat-delete"
        >
          <Trash2 size={12} />
        </button>
      )}
      <span className="ml-1.5 flex shrink-0">
        <StatusDot status={chat.status} />
      </span>
    </div>
  );
}

function ProjectsTab() {
  const projects = useWorkspace(useShallow((s) => Object.values(s.projects)));
  const chats = useWorkspace(useShallow((s) => Object.values(s.chats).map((c) => c.summary)));
  const views = useWorkspace((s) => s.views);
  const activeView = useWorkspace((s) => s.activeView);
  const mode = useWorkspace((s) => s.prefs?.layoutMode ?? "lattice");
  const nodeCount = useWorkspace((s) => s.nodes.length);
  const focusNode = useWorkspace((s) => s.focusNode);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const { openFolder } = useCanvasActions();
  const loose = chats.filter((c) => !c.projectId).sort((a, b) => Number(b.role === "conductor") - Number(a.role === "conductor"));
  const place = (id: string, label: string, Icon: typeof LayoutGrid, on: boolean, run: () => void, count?: number) => (
    <button
      key={id}
      onClick={run}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13px]",
        on ? "bg-surface-2 text-text-1" : "text-text-2 hover:bg-surface-2 hover:text-text-1",
      )}
      data-testid={`sidebar-${id}`}
    >
      <Icon size={14} className={on ? "text-accent" : "text-text-3"} />
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-[11px] text-text-3">{count}</span>}
    </button>
  );
  return (
    <div className="p-1.5">
      <Section title="Workspace">
        {place("lattice", "Lattice", Grid2x2, !activeView && mode === "lattice", () => runCommand("view.lattice"), chats.length)}
        {place("canvas", "Canvas", LayoutGrid, !activeView && mode === "canvas", () => runCommand("view.canvas"), nodeCount)}
        {views.map((v) =>
          place(`view-${v.id}`, v.name, ScanSearch, activeView === v.id, () => useWorkspace.getState().openView(v.id), v.chatIds.length),
        )}
      </Section>
      {loose.length > 0 && (
        <Section title="Chats">
          {loose.map((c) => (
            <ChatRow key={c.id} chat={c} indent={false} />
          ))}
        </Section>
      )}
      <Section
        title="Projects"
        action={
          <button
            aria-label="Open folder as project"
            title="Open folder as project"
            className="rounded-[2px] p-0.5 hover:bg-surface-2 hover:text-text-1"
            onClick={() => void openFolder()}
          >
            <Plus size={13} />
          </button>
        }
      >
        {projects.map((p) => {
          const mine = chats.filter((c) => c.projectId === p.id);
          const working = mine.filter((c) => c.status === "working").length;
          const needs = mine.filter((c) => c.status === "needs-you").length;
          const open = !closed.has(p.id);
          return (
            <div key={p.id}>
              <div className="group flex h-8 w-full items-center rounded-control text-[13px] text-text-1 hover:bg-surface-2">
                <button
                  aria-label={open ? `Collapse ${p.name}` : `Expand ${p.name}`}
                  className="flex h-8 w-6 shrink-0 items-center justify-center text-text-3 hover:text-text-1"
                  onClick={() =>
                    setClosed((c) => {
                      const n = new Set(c);
                      if (n.has(p.id)) n.delete(p.id);
                      else n.add(p.id);
                      return n;
                    })
                  }
                >
                  <ChevronRight size={12} className={cn("transition-transform duration-fast", open && "rotate-90")} />
                </button>
                <button
                  onClick={() => focusNode(p.frameNodeId)}
                  className="flex min-w-0 flex-1 items-center gap-2 pr-2 text-left"
                  data-testid="sidebar-project"
                >
                  <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: PROJECT_COLORS[p.color] ?? PROJECT_COLORS.teal }} />
                  <span className="flex-1 truncate">{p.name}</span>
                  {working > 0 && (
                    <span className="flex items-center gap-1 text-[11px] text-text-2">
                      <StatusDot status="working" />
                      {working}
                    </span>
                  )}
                  {needs > 0 && (
                    <span className="flex items-center gap-1 text-[11px] text-text-2">
                      <StatusDot status="needs-you" />
                      {needs}
                    </span>
                  )}
                  {!working && !needs && <span className="text-[11px] text-text-3">{mine.length}</span>}
                </button>
              </div>
              {open && mine.map((c) => <ChatRow key={c.id} chat={c} indent />)}
            </div>
          );
        })}
        {projects.length === 0 && (
          <>
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void openFolder()}>
              <FolderOpen size={13} /> Open folder…
            </Button>
            <p className="px-2 pt-1 text-[12px] leading-relaxed text-text-3">Each folder you open becomes a project frame on the canvas.</p>
          </>
        )}
      </Section>
    </div>
  );
}

/** The selected project's files (git's view), filterable; click to open. */
function FilesTab() {
  const projects = useWorkspace(useShallow((s) => Object.values(s.projects)));
  const selected = useWorkspace((s) => {
    const n = s.nodes.find((x) => x.selected);
    return n?.data.projectId ?? (n?.data.chatId ? s.chats[n.data.chatId]?.summary.projectId : undefined);
  });
  const [pick, setPick] = useState<string | null>(null);
  const projectId = pick ?? selected ?? projects[0]?.id ?? null;
  const [files, setFiles] = useState<{ projectId: string; list: string[] } | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void latis.invoke("project:files", { projectId }).then((list) => live && setFiles({ projectId, list }));
    return () => {
      live = false;
    };
  }, [projectId]);
  if (!projects.length) return <p className="p-4 text-[12px] leading-relaxed text-text-3">Open a folder to see its files here.</p>;
  const list = files?.projectId === projectId ? files.list : [];
  const needle = q.trim().toLowerCase();
  const shown = (needle ? list.filter((f) => f.toLowerCase().includes(needle)) : list).slice(0, 400);
  return (
    <div className="flex h-full flex-col p-1.5" data-testid="files-tab">
      {projects.length > 1 && (
        <select
          value={projectId ?? ""}
          onChange={(e) => setPick(e.target.value)}
          aria-label="Project"
          className="mb-1.5 h-7 rounded-control border border-line bg-surface px-1.5 text-[12px] text-text-1"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter files"
        aria-label="Filter files"
        className="mb-1 h-7 rounded-control border border-line bg-bg-1 px-2 text-[12px] text-text-1 outline-none focus:border-line-strong"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.map((f) => {
          const slash = f.lastIndexOf("/");
          return (
            <button
              key={f}
              title={f}
              onClick={() => projectId && void latis.invoke("project:openFile", { projectId, path: f })}
              className="flex h-6 w-full items-center gap-1.5 rounded-control px-1.5 text-left text-[12px] hover:bg-surface-2"
            >
              <FileText size={11} className="shrink-0 text-text-3" />
              <span className="truncate text-text-1">{f.slice(slash + 1)}</span>
              {slash > 0 && <span className="min-w-0 truncate text-[11px] text-text-3">{f.slice(0, slash)}</span>}
            </button>
          );
        })}
        {list.length > shown.length && !needle && (
          <p className="px-2 py-1 text-[11px] text-text-3">Showing 400 of {list.length}. Filter to find more.</p>
        )}
      </div>
    </div>
  );
}
