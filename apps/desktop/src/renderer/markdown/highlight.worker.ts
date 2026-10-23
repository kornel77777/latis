// Syntax highlighting off the main thread (SPEC §4, §14). JS regex engine: no WASM, so the CSP stays strict.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const langs: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};
const aliases: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  rs: "rust",
};

let hl: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();

function highlighter() {
  hl ??= createHighlighterCore({
    themes: [import("shiki/themes/github-dark-default.mjs"), import("shiki/themes/github-light-default.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return hl;
}

self.onmessage = async (e: MessageEvent<{ id: number; code: string; lang: string }>) => {
  const { id, code } = e.data;
  const lang = aliases[e.data.lang] ?? e.data.lang;
  try {
    const h = await highlighter();
    const load = langs[lang];
    if (!load) return self.postMessage({ id, html: null });
    if (!loaded.has(lang)) {
      await h.loadLanguage((await load()) as Parameters<HighlighterCore["loadLanguage"]>[0]);
      loaded.add(lang);
    }
    const html = h.codeToHtml(code, {
      lang,
      themes: { dark: "github-dark-default", light: "github-light-default" },
      defaultColor: false,
    });
    self.postMessage({ id, html });
  } catch {
    self.postMessage({ id, html: null });
  }
};
