import { useState } from "react";
import {
  Check,
  CircleAlert,
  FolderOpen,
  FolderTree,
  Inbox,
  LayoutGrid,
  MessageCircleQuestion,
  ScrollText,
  ShieldQuestion,
  Timer,
  X,
} from "lucide-react";
import type { AttentionItem } from "@latis/shared";
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
                className="rounded-full bg-state-needs-you px-1.5 text-[10px] font-semibold leading-4 text-bg-0"
                data-testid="inbox-count"
              >
                {inboxCount}
              </span>
            )}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tab === "projects" && <ProjectsTab />}
        {tab === "files" && (
          <p className="p-4 text-[12px] leading-relaxed text-text-3">The file tree arrives with the diff viewer in M3.</p>
        )}
        {tab === "inbox" && <InboxTab />}
      </div>
    </aside>
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
            className="ml-auto rounded p-1 text-text-3 opacity-0 hover:text-text-1 group-hover:opacity-100"
            onClick={() => void dismissAttention(item.id)}
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

function ProjectsTab() {
  const projects = useWorkspace(useShallow((s) => Object.values(s.projects)));
  const chats = useWorkspace(useShallow((s) => Object.values(s.chats).map((c) => c.summary)));
  const focusNode = useWorkspace((s) => s.focusNode);
  const { openFolder } = useCanvasActions();
  return (
    <div className="p-1.5">
      {projects.map((p) => {
        const mine = chats.filter((c) => c.projectId === p.id);
        const working = mine.filter((c) => c.status === "working").length;
        const needs = mine.filter((c) => c.status === "needs-you").length;
        const done = mine.filter((c) => c.status === "done").length;
        return (
          <div key={p.id}>
            <button
              onClick={() => focusNode(p.frameNodeId)}
              className="flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-[13px] text-text-1 hover:bg-surface-2"
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
              {done > 0 && (
                <span className="flex items-center gap-1 text-[11px] text-text-2">
                  <StatusDot status="done" />
                  {done}
                </span>
              )}
            </button>
            {mine.map((c) => (
              <button
                key={c.id}
                onClick={() => focusNode(c.nodeId)}
                className="flex h-7 w-full items-center gap-2 rounded-control pl-6 pr-2 text-left text-[12px] text-text-2 hover:bg-surface-2 hover:text-text-1"
              >
                <StatusDot status={c.status} />
                <span className="truncate">{c.title}</span>
              </button>
            ))}
          </div>
        );
      })}
      <Button variant="ghost" size="sm" className="mt-1 w-full justify-start" onClick={() => void openFolder()}>
        <FolderOpen size={13} /> Open folder…
      </Button>
      {projects.length === 0 && (
        <p className="px-2 pt-2 text-[12px] leading-relaxed text-text-3">Each folder you open becomes a project frame on the canvas.</p>
      )}
    </div>
  );
}
