import { useEffect, useRef, useState } from "react";
import { Background, BackgroundVariant, MiniMap, ReactFlow, useReactFlow, useViewport, type NodeTypes } from "@xyflow/react";
import { AppWindow, FolderOpen, LayoutGrid, Sparkles, StickyNote } from "lucide-react";
import { Button, cn } from "@latis/ui";
import { ChatNode } from "../chat/ChatNode";
import { useWorkspace } from "../stores/workspace";
import { Checklist } from "../app/Checklist";
import { NoteNode } from "./NoteNode";
import { CardNode } from "./CardNode";
import { ProjectFrame } from "./ProjectFrame";
import { useCanvasActions } from "./useCanvasActions";

const nodeTypes: NodeTypes = { chat: ChatNode, frame: ProjectFrame, note: NoteNode, card: CardNode };

let visibleTimer: ReturnType<typeof setTimeout> | null = null;
/** Tells main which chats are on screen, so it can skip their notifications while Latis is focused (§8.6). */
function reportVisibleChats(container: HTMLElement | null) {
  if (visibleTimer) clearTimeout(visibleTimer);
  visibleTimer = setTimeout(() => {
    if (!container) return;
    const box = container.getBoundingClientRect();
    const ids = [...container.querySelectorAll<HTMLElement>("[data-chat-id]")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom && r.width > 40;
      })
      .map((el) => el.dataset.chatId!);
    void window.latis.invoke("ui:visibleChats", { chatIds: ids }).catch(() => undefined);
  }, 250);
}

export function CanvasView() {
  const nodes = useWorkspace((s) => s.nodes);
  const onNodesChange = useWorkspace((s) => s.onNodesChange);
  const saveViewport = useWorkspace((s) => s.saveViewport);
  const initialViewport = useWorkspace((s) => s.initialViewport);
  const focusRequest = useWorkspace((s) => s.focusRequest);
  const flow = useReactFlow();
  const { openFolder, newDemoChat } = useCanvasActions();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const grid = useWorkspace((s) => s.prefs?.appearance.grid ?? "dots");
  const wallpaper = useWorkspace((s) => s.prefs?.appearance.wallpaper ?? null);
  const nodeCount = nodes.length;
  // The Conductor alone doesn't make the canvas non-empty; the welcome moves aside for it.
  const conductorNode = useWorkspace((s) => Object.values(s.chats).find((c) => c.summary.role === "conductor")?.summary.nodeId);
  const empty = nodes.every((n) => n.id === conductorNode);
  useEffect(() => reportVisibleChats(container.current), [nodeCount, focusRequest]);

  useEffect(() => {
    if (!focusRequest) return;
    // Wait a frame so a just-added node has been measured.
    const id = requestAnimationFrame(
      () => void flow.fitView({ nodes: [{ id: focusRequest.nodeId }], duration: 320, maxZoom: 1, padding: 0.15 }),
    );
    return () => cancelAnimationFrame(id);
  }, [focusRequest, flow]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable]")) return;
      const mod = e.metaKey || e.ctrlKey;
      const ws = useWorkspace.getState();
      // Canvas undo/redo (§7.2); text fields keep their own.
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        void (e.shiftKey ? ws.redo() : ws.undo());
        return;
      }
      // Enter on a focused chat jumps into its composer (keyboard-only use, §8.12).
      if (!mod && e.key === "Enter") {
        const node = (e.target as HTMLElement).closest(".react-flow__node");
        const composer = node?.querySelector<HTMLTextAreaElement>("[data-testid=composer]");
        if (composer) {
          e.preventDefault();
          composer.focus();
          return;
        }
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        useWorkspace.setState((st) => ({ nodes: st.nodes.map((n) => ({ ...n, selected: n.type !== "frame" })) }));
        return;
      }
      if (!mod && (e.key === "Delete" || e.key === "Backspace")) {
        const ids = ws.nodes.filter((n) => n.selected).map((n) => n.id);
        if (ids.length) {
          e.preventDefault();
          void ws.deleteNodes(ids);
        }
        return;
      }
      if (!mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        ws.focusSelection();
        return;
      }
      if (!mod && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        const box = container.current?.getBoundingClientRect();
        const at = box
          ? flow.screenToFlowPosition({ x: box.left + box.width / 2 - 170, y: box.top + box.height / 2 - 130 })
          : { x: 0, y: 0 };
        void ws.createNote(at);
        return;
      }
      if (e.shiftKey && e.code === "Digit1") void flow.fitView({ duration: 320 });
      if (e.shiftKey && e.code === "Digit2") void flow.fitView({ nodes: flow.getNodes().filter((n) => n.selected), duration: 320 });
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey && e.key === "0") void flow.zoomTo(1, { duration: 200 });
      // Keyboard zoom (Ctrl/⌘ +/− stays the interface-size zoom).
      if (!e.metaKey && !e.ctrlKey && e.key === "-") void flow.zoomOut({ duration: 150 });
      if (!e.metaKey && !e.ctrlKey && (e.key === "=" || e.key === "+")) void flow.zoomIn({ duration: 150 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow]);

  return (
    <div ref={container} className="relative min-w-0 flex-1 bg-bg-1" onClick={() => setMenu(null)}>
      {wallpaper && <div className="latis-wallpaper" style={{ backgroundImage: `url(${wallpaper})` }} data-testid="wallpaper" />}
      <ReactFlow
        nodes={nodes}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={initialViewport ?? { x: 80, y: 60, zoom: 1 }}
        onMoveEnd={(_e, v) => {
          saveViewport(v);
          reportVisibleChats(container.current);
        }}
        minZoom={0.1}
        maxZoom={4}
        // §8.3 virtualisation: only nodes in the viewport mount; agents keep running in main.
        onlyRenderVisibleElements
        panOnScroll
        selectionOnDrag
        panOnDrag={[1]}
        panActivationKeyCode="Space"
        // Deleting goes through soft delete + undo (onKey), not React Flow's own removal.
        deleteKeyCode={null}
        zoomActivationKeyCode={["Meta", "Control"]}
        onPaneContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        proOptions={{ hideAttribution: true }}
        aria-label="Canvas"
        // A wallpaper shows through the canvas background.
        style={wallpaper ? ({ "--xy-background-color": "transparent" } as React.CSSProperties) : undefined}
      >
        {grid !== "none" && (
          <Background
            variant={grid === "lines" ? BackgroundVariant.Lines : BackgroundVariant.Dots}
            gap={grid === "lines" ? 40 : 20}
            size={1.2}
            color="var(--grid-dot)"
          />
        )}
        <MiniMap pannable zoomable position="bottom-right" nodeBorderRadius={6} />
        <ZoomBadge />
      </ReactFlow>

      <Checklist />
      {empty && (
        <div
          className={cn("pointer-events-none absolute inset-0 flex items-center", nodes.length ? "justify-end pr-[10%]" : "justify-center")}
        >
          <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 text-center">
            <div className="text-[16px] font-semibold text-text-1">An empty sky</div>
            <p className="text-[13px] leading-relaxed text-text-2">
              Open a folder to start a project, then put agents to work in it. Or try a scripted demo agent first.
            </p>
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void openFolder()} data-testid="empty-open-folder">
                <FolderOpen size={14} /> Open a folder
              </Button>
              <Button onClick={() => void newDemoChat()} data-testid="empty-demo">
                <Sparkles size={14} /> Try the demo
              </Button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <div
          role="menu"
          className="fixed z-50 min-w-44 rounded-control border border-line bg-surface p-1 shadow-lift"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-text-1 hover:bg-surface-2"
            onClick={() => {
              void openFolder(menu);
              setMenu(null);
            }}
          >
            <FolderOpen size={13} /> Open folder as project…
          </button>
          <button
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-text-1 hover:bg-surface-2"
            onClick={() => {
              void newDemoChat(menu);
              setMenu(null);
            }}
          >
            <Sparkles size={13} /> New demo chat
          </button>
          <button
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-text-1 hover:bg-surface-2"
            onClick={() => {
              void useWorkspace.getState().createNote(flow.screenToFlowPosition(menu));
              setMenu(null);
            }}
            data-testid="menu-new-note"
          >
            <StickyNote size={13} /> New note <kbd className="ml-auto font-mono text-[11px] text-text-3">N</kbd>
          </button>
          <button
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-text-1 hover:bg-surface-2"
            onClick={() => {
              useWorkspace.setState({ cardLibraryAt: flow.screenToFlowPosition(menu) });
              setMenu(null);
            }}
            data-testid="menu-new-card"
          >
            <AppWindow size={13} /> New card…
          </button>
          <button
            role="menuitem"
            className="flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] text-text-1 hover:bg-surface-2"
            onClick={() => {
              useWorkspace.getState().tidyUp();
              setMenu(null);
            }}
          >
            <LayoutGrid size={13} /> Tidy up
          </button>
        </div>
      )}
    </div>
  );
}

function ZoomBadge() {
  const { zoom } = useViewport();
  const flow = useReactFlow();
  return (
    <button
      onClick={() => void flow.zoomTo(1, { duration: 200 })}
      className="absolute bottom-[172px] right-[15px] z-10 rounded-control border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-text-2 hover:text-text-1"
      aria-label="Reset zoom to 100%"
      data-testid="zoom-badge"
    >
      {Math.round(zoom * 100)}%
    </button>
  );
}
