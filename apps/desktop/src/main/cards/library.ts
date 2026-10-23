// The starter card library (SPEC §12.3), bundled from resources/cards so it works offline.
const files = import.meta.glob<string>("../../../resources/cards/**/*", { query: "?raw", import: "default", eager: true });

const byPath = Object.fromEntries(Object.entries(files).map(([p, body]) => [p.replace(/^.*resources\/cards\//, ""), body]));
const meta = JSON.parse(byPath["library.json"] ?? "{}") as Record<string, { title: string; description: string }>;

export interface Starter {
  id: string;
  title: string;
  description: string;
  html: string;
  refreshScript?: string;
  /** Other files to copy (the shared stylesheet). */
  files: Record<string, string>;
}

export const starters: Starter[] = Object.entries(meta).map(([id, m]) => ({
  id,
  ...m,
  html: byPath[`${id}/index.html`] ?? "",
  ...(byPath[`${id}/refresh.mjs`] && { refreshScript: byPath[`${id}/refresh.mjs`] }),
  files: { "base.css": byPath["base.css"] ?? "" },
}));
