import { connect } from "node:net";
import { WebContentsView, session, shell, type BrowserWindow, type Rectangle } from "electron";

// Dock browser (SPEC §9.7): a sandboxed web view for previewing dev servers, with device
// presets and an element picker. It runs in its own session partition with no preload and
// no Node, so previewed pages can't reach Latis.

export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Set when the page failed to load (e.g. nothing listening on the port). */
  error: { code: number; description: string; url: string } | null;
}

export interface Picked {
  html: string;
  selector: string;
  styles: Record<string, string>;
  /** PNG of the element, base64 (no data: prefix). */
  imageBase64: string | null;
  url: string;
}

export const DEV_PORTS = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010, 4173, 5173, 8000, 8080];

export type Device = "responsive" | "phone" | "phone-landscape" | "tablet" | "tablet-landscape";
const DEVICES: Record<Exclude<Device, "responsive">, { width: number; height: number; scale: number; mobile: boolean }> = {
  phone: { width: 390, height: 844, scale: 3, mobile: true },
  "phone-landscape": { width: 844, height: 390, scale: 3, mobile: true },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true },
  "tablet-landscape": { width: 1180, height: 820, scale: 2, mobile: true },
};
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(300, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function detectDevPorts(): Promise<number[]> {
  const open = await Promise.all(DEV_PORTS.map(async (p) => ((await portOpen(p)) ? p : null)));
  return open.filter((p): p is number => p !== null);
}

/** Runs in the page (isolated world): highlights the hovered element, resolves with details of the clicked one. */
const PICKER = `new Promise((resolve) => {
  const box = document.createElement("div");
  Object.assign(box.style, { position: "fixed", zIndex: 2147483647, pointerEvents: "none", border: "2px solid #5eead4", background: "rgba(94,234,212,0.12)", borderRadius: "3px", transition: "all 60ms" });
  document.documentElement.appendChild(box);
  let current = null;
  const cssPath = (el) => {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.documentElement; e = e.parentElement) {
      if (e.id) { parts.unshift("#" + CSS.escape(e.id)); break; }
      let part = e.localName;
      const cls = [...e.classList].filter((c) => !/[:[\\]]/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
      const sibs = e.parentElement ? [...e.parentElement.children].filter((s) => s.localName === e.localName) : [];
      if (sibs.length > 1) part += ":nth-of-type(" + (sibs.indexOf(e) + 1) + ")";
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const move = (ev) => {
    current = ev.target;
    const r = current.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  };
  const stop = () => { document.removeEventListener("mousemove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", key, true); box.remove(); };
  const click = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const el = current || ev.target;
    stop();
    const cs = getComputedStyle(el);
    const keys = ["display","position","width","height","margin","padding","color","background-color","font-family","font-size","font-weight","line-height","border","border-radius","gap","flex-direction","justify-content","align-items"];
    const styles = {};
    for (const k of keys) { const v = cs.getPropertyValue(k); if (v && v !== "normal" && v !== "none" && v !== "0px" && v !== "auto") styles[k] = v; }
    let html = el.outerHTML;
    if (html.length > 2000) html = html.slice(0, 2000) + "…";
    const r = el.getBoundingClientRect();
    resolve({ html, selector: cssPath(el), styles, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, url: location.href });
  };
  const key = (ev) => { if (ev.key === "Escape") { stop(); resolve(null); } };
  document.addEventListener("mousemove", move, true);
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", key, true);
})`;

export class BrowserDock {
  private view: WebContentsView | null = null;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private visible = false;
  private device: Device = "responsive";
  private error: BrowserState["error"] = null;

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly onState: (s: BrowserState) => void,
  ) {}

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    const ses = session.fromPartition("persist:latis-preview");
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    const view = new WebContentsView({
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    const wc = view.webContents;
    // Links that open new windows go to the real browser.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const emit = () => this.onState(this.state());
    // The error clears only when Latis navigates or reloads: after a failed load Chromium starts
    // loading its own error page, which would otherwise wipe the error we just recorded.
    wc.on("did-start-loading", emit);
    wc.on("did-stop-loading", emit);
    wc.on("page-title-updated", emit);
    wc.on("did-navigate", emit);
    wc.on("did-navigate-in-page", emit);
    wc.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = aborted (a new navigation started)
      this.error = { code, description, url };
      this.applyBounds();
      emit();
    });
    this.view = view;
    this.window()?.contentView.addChildView(view);
    return view;
  }

  state(): BrowserState {
    const wc = this.view?.webContents;
    return {
      url: wc?.getURL() ?? "",
      title: wc?.getTitle() ?? "",
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      error: this.error,
    };
  }

  /** The dock area in window coordinates, and whether it's showing (hidden under dialogs, other tabs). */
  setBounds(b: Rectangle, visible: boolean): void {
    this.bounds = b;
    this.visible = visible;
    this.applyBounds();
  }

  private applyBounds(): void {
    if (!this.view) return;
    // An error page is drawn by the renderer, so the native view steps aside.
    const show = this.visible && !this.error && this.bounds.width > 0;
    this.view.setVisible(show);
    if (!show) return;
    const preset = this.device === "responsive" ? null : DEVICES[this.device];
    if (!preset) {
      this.view.setBounds(this.bounds);
      return;
    }
    // Fit the device viewport into the dock, centred; emulation scales the page to it.
    const scale = Math.min(1, this.bounds.width / preset.width, this.bounds.height / preset.height);
    const w = Math.round(preset.width * scale);
    const h = Math.round(preset.height * scale);
    this.view.setBounds({ x: this.bounds.x + Math.round((this.bounds.width - w) / 2), y: this.bounds.y, width: w, height: h });
  }

  async navigate(url: string): Promise<void> {
    const target = /^[a-z]+:\/\//i.test(url)
      ? url
      : /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(url) || /^:\d+/.test(url)
        ? `http://${url.replace(/^:/, "localhost:")}`
        : `https://${url}`;
    if (!/^https?:\/\//i.test(target)) throw new Error("Only http and https pages can be previewed.");
    const view = this.ensure();
    this.error = null;
    this.applyBounds();
    await view.webContents.loadURL(target).catch(() => undefined); // failures arrive via did-fail-load
  }

  back(): void {
    this.view?.webContents.navigationHistory.goBack();
  }
  forward(): void {
    this.view?.webContents.navigationHistory.goForward();
  }
  reload(): void {
    this.error = null;
    this.view?.webContents.reload();
  }

  /** Device presets with touch emulation (§9.7 AC2), via the DevTools protocol. */
  async setDevice(device: Device): Promise<void> {
    this.device = device;
    const wc = this.ensure().webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const preset = device === "responsive" ? null : DEVICES[device];
    if (preset) {
      await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
        width: preset.width,
        height: preset.height,
        deviceScaleFactor: preset.scale,
        mobile: preset.mobile,
      });
      await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      await wc.debugger.sendCommand("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA });
    } else {
      await wc.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
      await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false });
      await wc.debugger.sendCommand("Emulation.setUserAgentOverride", { userAgent: wc.session.getUserAgent() });
    }
    this.applyBounds();
    wc.reload();
  }

  /** Waits for the user to click an element in the page (§9.7 AC3). Null if they pressed Esc. */
  async pick(): Promise<Picked | null> {
    const wc = this.view?.webContents;
    if (!wc || this.error) throw new Error("Open a page in the browser first.");
    wc.focus();
    const r = (await wc.executeJavaScriptInIsolatedWorld(999, [{ code: PICKER }], true)) as
      (Omit<Picked, "imageBase64"> & { rect: { x: number; y: number; width: number; height: number } }) | null;
    if (!r) return null;
    let imageBase64: string | null = null;
    if (r.rect.width >= 1 && r.rect.height >= 1) {
      const img = await wc.capturePage({
        x: Math.max(0, Math.floor(r.rect.x)),
        y: Math.max(0, Math.floor(r.rect.y)),
        width: Math.ceil(r.rect.width),
        height: Math.ceil(r.rect.height),
      });
      if (!img.isEmpty()) imageBase64 = img.toPNG().toString("base64");
    }
    return { html: r.html, selector: r.selector, styles: r.styles, url: r.url, imageBase64 };
  }

  dispose(): void {
    if (!this.view) return;
    this.window()?.contentView.removeChildView(this.view);
    this.view.webContents.close();
    this.view = null;
  }
}
