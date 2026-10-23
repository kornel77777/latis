import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Crosshair, Globe, RotateCw, SquareTerminal } from "lucide-react";
import { Button, Menu, MenuItem, MenuLabel, cn } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";

// Dock browser (§9.7). The page is a native view laid over `area`; this component reports
// where that is and draws everything else (toolbar, error page, picker hand-off).

type Device = "responsive" | "phone" | "phone-landscape" | "tablet" | "tablet-landscape";
const DEVICES: { id: Device; label: string }[] = [
  { id: "responsive", label: "Responsive" },
  { id: "phone", label: "Phone" },
  { id: "phone-landscape", label: "Phone, landscape" },
  { id: "tablet", label: "Tablet" },
  { id: "tablet-landscape", label: "Tablet, landscape" },
];

async function go(target: string) {
  try {
    const s = await latis.invoke("browser:navigate", { url: target });
    useWorkspace.setState({ browser: s });
  } catch (err) {
    useWorkspace.getState().toast(err instanceof Error ? err.message : String(err));
  }
}

export function BrowserPanel() {
  const state = useWorkspace((s) => s.browser);
  const chats = useWorkspace((s) => s.chats);
  const projectId = useWorkspace((s) => {
    const sel = s.nodes.find((n) => n.selected);
    const fromSel = sel?.data.projectId ?? (sel?.data.chatId ? s.chats[sel.data.chatId]?.summary.projectId : undefined);
    const all = Object.keys(s.projects);
    return fromSel ?? (all.length === 1 ? all[0]! : null);
  });
  // Native views draw above the DOM, so the page steps aside while any dialog is open.
  const covered = useWorkspace(
    (s) =>
      s.paletteOpen || s.settingsOpen || s.reviewPanel.open || s.onboardingOpen || Boolean(s.mergeFor || s.timelineFor || s.isolateOffer),
  );
  const area = useRef<HTMLDivElement>(null);
  /** What the user is typing in the address bar; null shows the page's URL. */
  const [edit, setEdit] = useState<string | null>(null);
  const url = edit ?? state?.url ?? "";
  const [ports, setPorts] = useState<number[]>([]);
  const [device, setDevice] = useState<Device>("responsive");
  const [picked, setPicked] = useState<Awaited<ReturnType<typeof latis.invoke<"browser:pick">>>>(null);
  const [picking, setPicking] = useState(false);

  // Keep the native view on top of `area`.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const report = () => {
      const r = el.getBoundingClientRect();
      void latis.invoke("browser:bounds", {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
        visible: !covered && r.width > 0 && !picked,
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
      void latis.invoke("browser:bounds", { x: 0, y: 0, width: 0, height: 0, visible: false });
    };
  }, [covered, picked]);

  // First open: find running dev servers and show the first one (§9.7 AC1).
  useEffect(() => {
    void latis.invoke("browser:detect").then((found) => {
      setPorts(found);
      if (!useWorkspace.getState().browser?.url && found[0]) void go(`localhost:${found[0]}`);
    });
  }, []);

  const pick = async () => {
    setPicking(true);
    try {
      const r = await latis.invoke("browser:pick");
      if (r) setPicked(r);
    } catch (err) {
      useWorkspace.getState().toast(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  /** Puts the picked element into a chat's composer (text + screenshot) and shows the chat (§9.7 AC3). */
  const sendTo = (chatId: string) => {
    if (!picked) return;
    const styles = Object.entries(picked.styles)
      .map(([k, v]) => `  ${k}: ${v};`)
      .join("\n");
    const block = `This element on ${picked.url}:\n\nSelector: \`${picked.selector}\`\n\n\`\`\`html\n${picked.html}\n\`\`\`\n\nKey styles:\n\`\`\`css\n${styles}\n\`\`\`\n\n`;
    useWorkspace.setState((s) => ({
      drafts: { ...s.drafts, [chatId]: block + (s.drafts[chatId] ?? "") },
      attachments: picked.imageBase64
        ? { ...s.attachments, [chatId]: [...(s.attachments[chatId] ?? []), { mime: "image/png" as const, dataBase64: picked.imageBase64 }] }
        : s.attachments,
    }));
    setPicked(null);
    useWorkspace.getState().focusChat(chatId);
  };

  const err = state?.error;
  const port = err ? /:(\d+)/.exec(err.url)?.[1] : undefined;
  const targets = Object.values(chats).map((c) => c.summary);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="browser-panel">
      <div className="flex items-center gap-1 border-b border-line px-1.5 py-1">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Back"
          disabled={!state?.canGoBack}
          onClick={() => void latis.invoke("browser:nav", "back")}
        >
          <ArrowLeft size={13} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Forward"
          disabled={!state?.canGoForward}
          onClick={() => void latis.invoke("browser:nav", "forward")}
        >
          <ArrowRight size={13} />
        </Button>
        <Button size="icon" variant="ghost" aria-label="Reload" onClick={() => void latis.invoke("browser:nav", "reload")}>
          <RotateCw size={13} className={state?.loading ? "animate-spin" : undefined} />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) void go(url.trim());
            setEdit(null);
          }}
        >
          <input
            value={url}
            onChange={(e) => setEdit(e.target.value)}
            placeholder="localhost:3000"
            aria-label="Address"
            className="h-7 w-full rounded-control border border-line bg-bg-1 px-2 font-mono text-[12px] text-text-1 outline-none focus:border-line-strong focus-visible:outline-none"
            data-testid="browser-url"
          />
        </form>
        <select
          value={device}
          onChange={(e) => {
            const d = e.target.value as Device;
            setDevice(d);
            void latis.invoke("browser:device", d);
          }}
          aria-label="Device"
          className="h-7 rounded-control border border-line bg-surface px-1 text-[12px] text-text-1"
        >
          {DEVICES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={picking ? "primary" : "secondary"}
          onClick={() => void pick()}
          disabled={!state?.url || Boolean(err) || picking}
          data-testid="pick-element"
        >
          <Crosshair size={12} /> {picking ? "Click an element…" : "Pick"}
        </Button>
      </div>
      {ports.length > 0 && (
        <div className="flex gap-1 border-b border-line px-2 py-1 text-[11px] text-text-3">
          Running:
          {ports.map((p) => (
            <button key={p} className="rounded px-1 font-mono text-accent hover:underline" onClick={() => void go(`localhost:${p}`)}>
              :{p}
            </button>
          ))}
        </div>
      )}
      <div ref={area} className={cn("relative min-h-0 flex-1", device !== "responsive" && "bg-bg-1")} data-testid="browser-area">
        {!state?.url && !err && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-text-3">
            <Globe size={22} />
            <p>Type an address, or start a dev server: Latis looks on ports 3000–3010, 4173, 5173, 8000 and 8080.</p>
          </div>
        )}
        {err && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="browser-error">
            <p className="text-[14px] font-medium text-text-1">{port ? `Nothing running on :${port}.` : "That page didn't load."}</p>
            <p className="text-[12px] text-text-3">{port ? "Start your dev server in the terminal, then reload." : err.description}</p>
            <div className="flex gap-2">
              {port && (
                <Button size="sm" variant="primary" onClick={() => void useWorkspace.getState().newTerminal(projectId)}>
                  <SquareTerminal size={12} /> Open a terminal
                </Button>
              )}
              <Button size="sm" variant="secondary" onClick={() => void latis.invoke("browser:nav", "reload")}>
                <RotateCw size={12} /> Try again
              </Button>
            </div>
          </div>
        )}
        {picked && (
          <div className="absolute inset-0 flex flex-col gap-3 overflow-y-auto bg-bg-0 p-4" data-testid="picked">
            <p className="text-[13px] font-medium text-text-1">Send this element to a chat</p>
            <code className="block truncate rounded-control bg-bg-1 px-2 py-1 font-mono text-[11.5px] text-text-2">{picked.selector}</code>
            {picked.imageBase64 && (
              <img
                src={`data:image/png;base64,${picked.imageBase64}`}
                alt="The picked element"
                className="max-h-40 self-start rounded-control border border-line object-contain"
              />
            )}
            <div className="flex gap-2">
              <Menu
                trigger={
                  <Button size="sm" variant="primary" disabled={!targets.length} data-testid="send-picked">
                    Send to chat…
                  </Button>
                }
              >
                <MenuLabel>Add to the composer of</MenuLabel>
                {targets.map((c) => (
                  <MenuItem key={c.id} onSelect={() => sendTo(c.id)}>
                    {c.title}
                  </MenuItem>
                ))}
              </Menu>
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
