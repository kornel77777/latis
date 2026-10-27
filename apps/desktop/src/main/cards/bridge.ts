// The card bridge (SPEC §12.2), served as card://<id>/__lattiz.js and injected into every card's
// HTML. It talks to Lattiz only through postMessage to the parent (the Lattiz window), which checks
// the message came from this card's frame before passing it on.

export const BRIDGE_JS = String.raw`(() => {
  const pending = new Map();
  let seq = 0;
  // PDF export renders the card on its own, with a read-only copy of its data and theme.
  const snap = window.__lattizSnapshot;
  const local = (method, args) => {
    if (method === "data.get") return Promise.resolve(snap.data[args[0]] ?? null);
    if (method === "data.list") return Promise.resolve(snap.data);
    if (method === "usage") return Promise.resolve(snap.usage ?? {});
    return Promise.resolve(null);
  };
  const call = (method, args) =>
    snap ? local(method, args) :
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      parent.postMessage({ __lattiz: true, id, method, args }, "*");
    });
  let theme = { mode: "dark", tokens: {} };
  const themeListeners = new Set();
  const dataListeners = new Set();
  const applyTheme = (t) => {
    const root = document.documentElement;
    root.dataset.theme = t.mode;
    for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty("--lattiz-" + k, v);
  };
  const lattiz = {
    data: {
      get: (key) => call("data.get", [key]),
      set: (key, value) => call("data.set", [key, value]),
      list: () => call("data.list", []),
      /** Called when the data changes outside the card (refresh, flows). */
      onChange: (fn) => (dataListeners.add(fn), () => dataListeners.delete(fn)),
    },
    refresh: () => call("refresh", []),
    ask: (prompt) => call("ask", [String(prompt)]),
    sendToFlow: (payload) => call("sendToFlow", [payload]),
    exportPdf: () => call("exportPdf", []),
    requestNetwork: (origins) => call("requestNetwork", [origins]),
    usage: () => call("usage", []),
    get theme() {
      return theme;
    },
    onThemeChange: (fn) => (themeListeners.add(fn), () => themeListeners.delete(fn)),
  };
  window.addEventListener("message", (e) => {
    if (e.source !== parent || !e.data) return;
    const m = e.data;
    if (m.__lattizReply) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.__lattizTheme) {
      theme = m.theme;
      applyTheme(m.theme);
      themeListeners.forEach((fn) => fn(m.theme));
    } else if (m.__lattizData) {
      dataListeners.forEach((fn) => fn());
    }
  });
  Object.defineProperty(window, "lattiz", { value: Object.freeze(lattiz) });
  if (snap) {
    theme = snap.theme;
    applyTheme(snap.theme);
  } else parent.postMessage({ __lattiz: true, id: 0, method: "ready", args: [] }, "*");
})();
`;
