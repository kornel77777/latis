import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { eventContract } from "@latis/shared";
import { latis } from "../api";

// One xterm per mounted view; the PTY itself lives in main (§9.6), so a view can
// unmount and remount (canvas switch, dock toggle) and repaint from the snapshot.

type Sink = (data: string) => void;
const sinks = new Map<string, Set<Sink>>();
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  latis.on("pty:data", (raw) => {
    const parsed = eventContract["pty:data"].safeParse(raw);
    if (!parsed.success) return;
    sinks.get(parsed.data.id)?.forEach((fn) => fn(parsed.data.data));
  });
}

function palette(): Terminal["options"]["theme"] {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg-0"),
    foreground: v("--text-1"),
    cursor: v("--accent"),
    cursorAccent: v("--bg-0"),
    selectionBackground: `${v("--accent")}55`,
  };
}

export interface TerminalHandle {
  search(term: string, backwards?: boolean): void;
}

export function TerminalView({
  ptyId,
  active = true,
  onReady,
  className,
}: {
  ptyId: string;
  active?: boolean;
  onReady?: (h: TerminalHandle) => void;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    wire();
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: palette(),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    // Links open in the browser (main's window-open handler allows http(s) only).
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri)));
    term.open(el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      // No WebGL (VMs, some Linux drivers): xterm's DOM renderer still works.
    }
    fitRef.current = fit;
    onReady?.({ search: (t, back) => (back ? search.findPrevious(t) : search.findNext(t)) });

    let disposed = false;
    const buffered: string[] = [];
    let painted = false;
    const sink: Sink = (d) => (painted ? term.write(d) : buffered.push(d));
    if (!sinks.has(ptyId)) sinks.set(ptyId, new Set());
    sinks.get(ptyId)!.add(sink);
    void latis.invoke("pty:snapshot", { id: ptyId }).then(({ data }) => {
      if (disposed) return;
      term.write(data);
      // Output that raced the snapshot is already in it only if it arrived first; the overlap is harmless repaint.
      buffered.forEach((d) => term.write(d));
      painted = true;
    });

    const input = term.onData((data) => void latis.invoke("pty:write", { id: ptyId, data }).catch(() => undefined));
    const resize = term.onResize(({ cols, rows }) => void latis.invoke("pty:resize", { id: ptyId, cols, rows }).catch(() => undefined));
    const ro = new ResizeObserver(() => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) fit.fit();
    });
    ro.observe(el);
    const themeObserver = new MutationObserver(() => (term.options.theme = palette()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });

    return () => {
      disposed = true;
      sinks.get(ptyId)?.delete(sink);
      ro.disconnect();
      themeObserver.disconnect();
      input.dispose();
      resize.dispose();
      term.dispose();
    };
    // onReady is a callback prop; re-creating the terminal for it would lose state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  useEffect(() => {
    if (active) requestAnimationFrame(() => fitRef.current?.fit());
  }, [active]);

  return <div ref={host} className={className} data-testid="terminal" data-pty={ptyId} />;
}
