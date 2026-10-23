import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { AppWindow, FileDown, FolderOpen, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { Button, Dialog, Menu, MenuItem, MenuSeparator } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace, type FlowNode } from "../stores/workspace";
import { FlowHandles } from "./flows";
import { useZoomLevel } from "./zoom";

// Cards (§12): a sandboxed iframe on its own card:// origin. This component is the only way a
// card reaches Latis: it relays bridge calls from that exact frame to main and answers them.

const errorText = (err: unknown) =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err);

const TOKENS: Record<string, string> = {
  surface: "--surface",
  bg: "--bg-0",
  text: "--text-1",
  "text-2": "--text-2",
  muted: "--text-3",
  accent: "--accent",
  line: "--line",
};

/** The current theme as the card bridge shares it (§12.2 `theme`). */
export function themeForCards() {
  const css = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [k, css.getPropertyValue(v).trim()]));
  tokens.font = getComputedStyle(document.body).fontFamily;
  return { mode: document.documentElement.dataset.theme === "light" ? "light" : "dark", tokens };
}

/** Cards have opaque origins (sandbox without allow-same-origin), so "*" is the only target. */
function postTo(el: HTMLIFrameElement | null, msg: unknown) {
  el?.contentWindow?.postMessage(msg, "*");
}

type BridgeCall = { __latis: true; id: number; method: string; args: unknown[] };

export const CardNode = memo(function CardNode({ id, data, selected }: NodeProps<FlowNode>) {
  const d = data as { cardId?: string; title?: string; rev?: number };
  const cardId = d.cardId ?? "";
  const level = useZoomLevel();
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useWorkspace((s) => s.theme);
  const accent = useWorkspace((s) => s.prefs?.appearance.accent);
  const [about, setAbout] = useState(false);
  const { toast, deleteNodes } = useWorkspace.getState();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this card's own frame; anything else (other cards, pages) is ignored.
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const m = e.data as BridgeCall | null;
      if (!m || m.__latis !== true || typeof m.method !== "string") return;
      const reply = (result: unknown, error?: string) =>
        postTo(frame.current, { __latisReply: true, id: m.id, ...(error ? { error } : { result: result ?? null }) });
      if (m.method === "ready") return void postTo(frame.current, { __latisTheme: true, theme: themeForCards() });
      if (m.method === "ask") {
        // Pre-fills the Conductor's composer; the user still presses send (§12.2).
        const ws = useWorkspace.getState();
        const conductor = Object.values(ws.chats).find((c) => c.summary.role === "conductor")?.summary;
        if (!conductor) return reply(null, "There's no Conductor to ask.");
        useWorkspace.setState((s) => ({ drafts: { ...s.drafts, [conductor.id]: String(m.args[0] ?? "").slice(0, 10_000) } }));
        ws.focusChat(conductor.id);
        useWorkspace.setState({ focusComposer: conductor.id });
        return reply(null);
      }
      const args = m.method === "exportPdf" ? [themeForCards()] : m.args;
      void latis
        .invoke("card:call", { cardId, method: m.method as "data.get", args: Array.isArray(args) ? args.slice(0, 4) : [] })
        .then((r) => reply(r))
        .catch((err: unknown) => reply(null, errorText(err)));
    };
    const onData = (e: Event) => {
      if ((e as CustomEvent<string>).detail === cardId) postTo(frame.current, { __latisData: true });
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("latis-card-data", onData);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("latis-card-data", onData);
    };
  }, [cardId]);

  // Theme and accent changes reach the card live.
  useEffect(() => {
    const t = setTimeout(() => postTo(frame.current, { __latisTheme: true, theme: themeForCards() }), 50);
    return () => clearTimeout(t);
  }, [theme, accent]);

  const call = (method: "refresh" | "exportPdf") =>
    void latis
      .invoke("card:call", { cardId, method, args: method === "exportPdf" ? [themeForCards()] : [] })
      .then(() => method === "refresh" && toast("Card refreshed."))
      .catch((err: unknown) => toast(errorText(err)));

  if (level === "tile") {
    return (
      <>
        <article
          data-testid="card"
          data-zoom="tile"
          className="latis-drag flex h-full w-full flex-col rounded-card border-2 border-line bg-surface p-8"
        >
          <AppWindow size={40} className="text-text-3" />
          <h3 className="mt-4 line-clamp-3 text-[44px] font-semibold leading-tight text-text-1">{d.title}</h3>
        </article>
        <FlowHandles nodeId={id} />
      </>
    );
  }

  return (
    <>
      <NodeResizer isVisible={selected} minWidth={240} minHeight={160} />
      <FlowHandles nodeId={id} />
      <article
        aria-label={`Card: ${d.title ?? "Card"}`}
        data-testid="card"
        data-card-id={cardId}
        className={`flex h-full w-full flex-col overflow-hidden rounded-card border bg-surface ${selected ? "border-line-strong shadow-lift" : "border-line"}`}
      >
        <header className="latis-drag flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-line px-3 active:cursor-grabbing">
          <AppWindow size={13} className="text-text-3" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-1">{d.title}</span>
          <div className="nodrag">
            <Menu
              trigger={
                <Button variant="ghost" size="icon" aria-label="Card menu">
                  <MoreHorizontal size={15} />
                </Button>
              }
            >
              <MenuItem onSelect={() => call("refresh")}>
                <RefreshCw size={13} /> Refresh
              </MenuItem>
              <MenuItem onSelect={() => call("exportPdf")}>
                <FileDown size={13} /> Export as PDF…
              </MenuItem>
              <MenuItem onSelect={() => void latis.invoke("card:openFolder", { cardId })}>
                <FolderOpen size={13} /> Open its folder
              </MenuItem>
              <MenuItem onSelect={() => setAbout(true)}>
                <AppWindow size={13} /> About this card
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={() => void deleteNodes([id])}>
                <Trash2 size={13} /> Delete
              </MenuItem>
            </Menu>
          </div>
        </header>
        <iframe
          ref={frame}
          key={d.rev ?? 1}
          title={d.title ?? "Card"}
          src={`card://${cardId}/index.html?v=${d.rev ?? 1}`}
          sandbox="allow-scripts allow-forms"
          className="nodrag nowheel min-h-0 w-full flex-1 border-0 bg-surface"
          data-testid="card-frame"
        />
      </article>
      <Dialog open={about} onOpenChange={setAbout} title={d.title ?? "Card"}>
        <p className="text-[13px] leading-relaxed text-text-2">
          This card runs in its own sandbox. It can&apos;t read your files, keys, chats or other cards, and it has no internet access unless
          you allowed specific sites when it asked. Its data is kept by Latis; a refresh script only runs after you approve it.
        </p>
      </Dialog>
    </>
  );
});
