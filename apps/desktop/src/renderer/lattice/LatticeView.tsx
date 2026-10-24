import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Columns3, EyeOff, GripVertical, Grid2x2, LayoutPanelLeft, Maximize2, Minimize2, Plus, Rows3, Scaling, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { LatticeNode } from "@latis/shared";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, cn } from "@latis/ui";
import { FullChat } from "../chat/ChatNode";
import { display } from "../commands/keys";
import { allCommands, bindingsOf, surfaces } from "../commands/registry";
import { useWorkspace } from "../stores/workspace";
import { rects, arrange, equalize, neighbour, paneIds, place, remove, resize, shift, sync, zoneAt, type Dir, type Zone } from "./tree";

// The lattice: every chat tiled side by side, for working on many things at once. Drag a pane by
// its header onto another pane's edge to split it there, or onto its middle to swap; drag the
// gutters to resize. Everything also has a command (Settings → Commands).

const GUTTER = 6;

/** The chats the lattice shows, Conductor first, then oldest first. */
function useLatticeChats(): string[] {
  return useWorkspace(
    useShallow((s) =>
      Object.values(s.chats)
        .map((c) => c.summary)
        .filter(
          (c) =>
            !s.lattice.hidden.includes(c.id) && (!s.lattice.projectId || c.projectId === s.lattice.projectId || c.role === "conductor"),
        )
        .sort((a, b) => Number(b.role === "conductor") - Number(a.role === "conductor") || a.createdAt - b.createdAt)
        .map((c) => c.id),
    ),
  );
}

const shortcut = (id: string) => {
  const c = allCommands().find((x) => x.id === id);
  const k = c && bindingsOf(c, useWorkspace.getState().prefs?.keybindings)[0];
  return k ? ` (${display(k)})` : "";
};

export function LatticeView() {
  const root = useWorkspace((s) => s.lattice.root);
  const projectId = useWorkspace((s) => s.lattice.projectId);
  const hidden = useWorkspace((s) => s.lattice.hidden);
  const focused = useWorkspace((s) => s.latticeFocus);
  const maximized = useWorkspace((s) => s.latticeMax);
  const projects = useWorkspace((s) => s.projects);
  const chats = useWorkspace((s) => s.chats);
  const ids = useLatticeChats();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1600, h: 1000 });
  const { setLattice } = useWorkspace.getState();
  const [drag, setDrag] = useState<{ id: string; x: number; y: number; on: boolean } | null>(null);
  const [drop, setDrop] = useState<{ id: string; zone: Zone } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1600, h: el.clientHeight || 1000 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the tree in step with the chats: new ones tile in, deleted ones leave.
  useEffect(() => {
    const have = paneIds(root);
    if (have.length === ids.length && ids.every((id) => have.includes(id))) return;
    setLattice({ root: sync(root, ids, size.w, size.h) });
  }, [ids, root, size.w, size.h, setLattice]);

  const focusPane = useCallback((chatId: string) => {
    const s = useWorkspace.getState();
    const nodeId = s.chats[chatId]?.summary.nodeId;
    // The focused pane is the selected chat, so chat commands (stop, timeline…) act on it.
    useWorkspace.setState({
      latticeFocus: chatId,
      nodes: s.nodes.map((n) => (n.selected === (n.id === nodeId) ? n : { ...n, selected: n.id === nodeId })),
    });
    s.markSeen(chatId);
  }, []);

  // A notification click or Ctrl+J asks for a chat: show it here.
  const request = useWorkspace((s) => s.focusRequest);
  useEffect(() => {
    if (!request) return;
    const chat = Object.values(useWorkspace.getState().chats).find((c) => c.summary.nodeId === request.nodeId);
    if (!chat) return;
    if (useWorkspace.getState().latticeMax && useWorkspace.getState().latticeMax !== chat.summary.id)
      useWorkspace.setState({ latticeMax: null });
    focusPane(chat.summary.id);
  }, [request, focusPane]);

  // Commands for this view (Settings → Commands → Lattice).
  useEffect(() => {
    const cur = () => {
      const s = useWorkspace.getState();
      return s.latticeFocus && paneIds(s.lattice.root).includes(s.latticeFocus) ? s.latticeFocus : paneIds(s.lattice.root)[0];
    };
    surfaces.lattice = {
      focus: (d: Dir) => {
        const c = cur();
        const n = c && neighbour(useWorkspace.getState().lattice.root, c, d, size.w, size.h);
        if (n) focusPane(n);
      },
      move: (d: Dir) => {
        const s = useWorkspace.getState();
        const c = cur();
        const n = c && neighbour(s.lattice.root, c, d, size.w, size.h);
        if (c && n && s.lattice.root) setLattice({ root: place(s.lattice.root, c, n, "center") });
      },
      toggleMaximize: () => {
        const c = cur();
        if (c) useWorkspace.setState((s) => ({ latticeMax: s.latticeMax ? null : c }));
      },
      closePane: () => {
        const c = cur();
        if (c) takeOut(c);
      },
      arrange: (preset) => setLattice({ root: arrange(preset, orderOf(useWorkspace.getState().lattice.root, ids), size.w, size.h) }),
      equalize: () => setLattice({ root: equalize(useWorkspace.getState().lattice.root) }),
    };
    return () => {
      surfaces.lattice = null;
    };
  }, [ids, size.w, size.h, setLattice, focusPane]);

  // ── Dragging panes by their header ──────────────────────────────────────────
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      if (!drag.on) setDrag({ ...drag, on: true });
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-pane]");
      const target = el?.dataset.pane;
      if (!el || !target || target === drag.id) return setDrop(null);
      const r = el.getBoundingClientRect();
      setDrop({ id: target, zone: zoneAt({ x: r.left, y: r.top, w: r.width, h: r.height }, e.clientX, e.clientY) });
    };
    const up = () => {
      const s = useWorkspace.getState();
      if (drag.on && drop && s.lattice.root) {
        setLattice({ root: place(s.lattice.root, drag.id, drop.id, drop.zone) });
        focusPane(drag.id);
      }
      setDrag(null);
      setDrop(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag, drop, setLattice, focusPane]);

  const startDrag = (chatId: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, select, textarea, [role=menuitem]")) return;
    setDrag({ id: chatId, x: e.clientX, y: e.clientY, on: false });
  };

  const renderPane = (chatId: string) => {
    if (!chats[chatId]) return null;
    const max = maximized === chatId;
    const isDrop = drop?.id === chatId ? drop.zone : null;
    return (
      <div
        key={chatId}
        data-pane={chatId}
        data-testid="lattice-pane"
        onPointerDownCapture={() => focusPane(chatId)}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("header") && !(e.target as HTMLElement).closest("button, input"))
            useWorkspace.setState((s) => ({ latticeMax: s.latticeMax === chatId ? null : chatId }));
        }}
        className={cn(
          "relative h-full w-full min-w-0 overflow-hidden rounded-card transition-shadow duration-fast",
          focused === chatId ? "ring-2 ring-accent/70" : "ring-0",
          drag?.on && drag.id === chatId && "opacity-40",
        )}
      >
        <FullChat
          chatId={chatId}
          selected={focused === chatId}
          inCanvas={false}
          onHeaderPointerDown={startDrag(chatId)}
          paneGrip={
            <span
              className="-ml-1.5 flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-text-3 hover:text-text-1 active:cursor-grabbing"
              title="Drag to move"
              data-testid="pane-grip"
            >
              <GripVertical size={13} />
            </span>
          }
          paneControls={
            <>
              <Button
                size="icon"
                variant="ghost"
                aria-label={max ? "Restore pane" : "Maximise pane"}
                title={(max ? "Restore" : "Maximise") + shortcut("lattice.maximize")}
                onClick={() => useWorkspace.setState({ latticeMax: max ? null : chatId })}
              >
                {max ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Take out of the lattice"
                title={"Take out of the lattice" + shortcut("lattice.close")}
                onClick={() => takeOut(chatId)}
              >
                <X size={13} />
              </Button>
            </>
          }
        />
        {isDrop && <DropHint zone={isDrop} />}
      </div>
    );
  };

  const shown = maximized && paneIds(root).includes(maximized) ? null : root;
  const projectList = Object.values(projects);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-bg-1" data-testid="lattice">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <Grid2x2 size={14} className="text-accent" />
        <span className="text-[13px] font-semibold text-text-1">Lattice</span>
        <span className="text-[12px] text-text-3">{ids.length} chats</span>
        {projectList.length > 0 && (
          <select
            value={projectId ?? ""}
            onChange={(e) => setLattice({ projectId: e.target.value || null })}
            aria-label="Which chats"
            className="ml-2 h-7 rounded-control border border-line bg-surface px-1.5 text-[12px] text-text-1"
          >
            <option value="">All projects</option>
            {projectList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-0.5" role="toolbar" aria-label="Arrange">
          {(
            [
              ["grid", Grid2x2, "Grid", "lattice.grid"],
              ["columns", Columns3, "Columns", "lattice.columns"],
              ["rows", Rows3, "Rows", "lattice.rows"],
              ["main", LayoutPanelLeft, "Main + stack", "lattice.main"],
            ] as const
          ).map(([preset, Icon, label, cmd]) => (
            <Button
              key={preset}
              size="icon"
              variant="ghost"
              aria-label={label}
              title={label + shortcut(cmd)}
              onClick={() => surfaces.lattice?.arrange(preset)}
              data-testid={`arrange-${preset}`}
            >
              <Icon size={14} />
            </Button>
          ))}
          <Button
            size="icon"
            variant="ghost"
            aria-label="Equal sizes"
            title={"Equal sizes" + shortcut("lattice.equalize")}
            onClick={() => surfaces.lattice?.equalize()}
          >
            <Scaling size={14} />
          </Button>
          {hidden.length > 0 && (
            <Menu
              trigger={
                <Button size="sm" variant="ghost" aria-label="Chats taken out">
                  <EyeOff size={12} /> {hidden.length}
                </Button>
              }
            >
              <MenuLabel>Put back into the lattice</MenuLabel>
              {hidden.map((id) => (
                <MenuItem key={id} onSelect={() => setLattice({ hidden: hidden.filter((h) => h !== id) })}>
                  {chats[id]?.summary.title ?? "Deleted chat"}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => setLattice({ hidden: [] })}>Put all back</MenuItem>
            </Menu>
          )}
          <NewChatMenu projectId={projectId} />
        </div>
      </div>
      <div ref={box} className={cn("relative min-h-0 flex-1 p-1.5", drag?.on && "cursor-grabbing select-none")}>
        {!ids.length ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Grid2x2 size={28} className="text-text-3" />
            <p className="max-w-sm text-[13px] leading-relaxed text-text-2">
              The lattice tiles your chats side by side. Start a chat and it slots in; drag a pane by its header to an edge to split, or to
              the middle to swap.
            </p>
            <NewChatMenu projectId={projectId} primary />
          </div>
        ) : shown ? (
          <Tile node={shown} path={[]} renderPane={renderPane} />
        ) : (
          renderPane(maximized!)
        )}
      </div>
    </div>
  );
}

/** Takes a chat out of the lattice; it stays on the canvas and can be put back. */
function takeOut(chatId: string) {
  const s = useWorkspace.getState();
  s.setLattice({ root: remove(s.lattice.root, chatId), hidden: [...s.lattice.hidden, chatId] });
  if (s.latticeMax === chatId) useWorkspace.setState({ latticeMax: null });
}

/** Panes in reading order as they look now (top row left to right, then down), then anything new; presets keep it. */
function orderOf(root: LatticeNode | null, ids: string[]): string[] {
  const at = rects(root, 1000, 1000);
  const tiled = [...at.entries()]
    .filter(([id]) => ids.includes(id))
    .sort(([, a], [, b]) => Math.round(a.y) - Math.round(b.y) || a.x - b.x)
    .map(([id]) => id);
  return [...tiled, ...ids.filter((id) => !tiled.includes(id))];
}

function DropHint({ zone }: { zone: Zone }) {
  const pos: Record<Zone, string> = {
    left: "inset-y-0 left-0 w-1/2",
    right: "inset-y-0 right-0 w-1/2",
    up: "inset-x-0 top-0 h-1/2",
    down: "inset-x-0 bottom-0 h-1/2",
    center: "inset-0",
  };
  return (
    <div
      className={cn("pointer-events-none absolute z-20 rounded-card border-2 border-accent bg-accent/15", pos[zone])}
      data-testid="drop-hint"
      data-zone={zone}
    >
      {zone === "center" && (
        <span className="absolute inset-0 m-auto h-6 w-fit rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg">
          Swap
        </span>
      )}
    </div>
  );
}

function Tile({ node, path, renderPane }: { node: LatticeNode; path: number[]; renderPane: (id: string) => ReactNode }) {
  if (node.kind === "pane") return <>{renderPane(node.chatId)}</>;
  const row = node.dir === "row";
  return (
    <div className={cn("flex h-full w-full min-h-0 min-w-0", row ? "flex-row" : "flex-col")}>
      {node.children.map((c, i) => (
        <Fragment key={c.kind === "pane" ? c.chatId : `s${i}`}>
          {i > 0 && <Gutter row={row} path={path} index={i - 1} sizes={node.sizes} />}
          <div className="min-h-0 min-w-0" style={{ flex: `${node.sizes[i] ?? 0} 1 0px` }}>
            <Tile node={c} path={[...path, i]} renderPane={renderPane} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

/** Drag to move the boundary between two neighbours; double-click to even them out. */
function Gutter({ row, path, index, sizes }: { row: boolean; path: number[]; index: number; sizes: number[] }) {
  const { setLattice } = useWorkspace.getState();
  const apply = (next: number[], save: boolean) => {
    const root = useWorkspace.getState().lattice.root;
    if (root) setLattice({ root: resize(root, path, next) }, save);
  };
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      className={cn("group relative z-10 shrink-0", row ? "cursor-col-resize" : "cursor-row-resize")}
      style={row ? { width: GUTTER } : { height: GUTTER }}
      onDoubleClick={() => {
        const pair = (sizes[index]! + sizes[index + 1]!) / 2;
        apply(
          sizes.map((s, j) => (j === index || j === index + 1 ? pair : s)),
          true,
        );
      }}
      onPointerDown={(e) => {
        const parent = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const total = row ? parent.width : parent.height;
        const start = row ? e.clientX : e.clientY;
        const base = sizes;
        let last = base;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => {
          last = shift(base, index, ((row ? ev.clientX : ev.clientY) - start) / total);
          apply(last, false);
        };
        const up = () => {
          apply(last, true);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      data-testid="lattice-gutter"
    >
      <div
        className={cn(
          "absolute rounded-full bg-line opacity-0 transition-opacity group-hover:bg-accent group-hover:opacity-100",
          row ? "inset-y-2 left-[2px] w-[2px]" : "inset-x-2 top-[2px] h-[2px]",
        )}
      />
    </div>
  );
}

/** New chat from the lattice: it tiles in next to the largest pane. */
function NewChatMenu({ projectId, primary = false }: { projectId: string | null; primary?: boolean }) {
  const agents = useWorkspace(useShallow((s) => s.agents.filter((a) => a.installed)));
  const projects = useWorkspace((s) => s.projects);
  const target = projectId ?? (Object.keys(projects).length === 1 ? Object.keys(projects)[0]! : null);
  return (
    <Menu
      trigger={
        <Button size="sm" variant={primary ? "primary" : "secondary"} data-testid="lattice-new-chat">
          <Plus size={12} /> New chat
        </Button>
      }
    >
      <MenuLabel>{target ? `In ${projects[target]?.name}` : "Pick a project in the filter first, or start a demo"}</MenuLabel>
      {agents.map((a) => (
        <MenuItem
          key={a.id}
          disabled={a.id !== "fake" && !target}
          onSelect={() =>
            void useWorkspace
              .getState()
              .createChat({ agentId: a.id, projectId: a.id === "fake" && !useWorkspace.getState().demoInProjects ? null : target })
          }
        >
          {a.displayName}
        </MenuItem>
      ))}
    </Menu>
  );
}
