import type { LatticeNode } from "@lattiz/shared";

// The lattice: chats tiled in a tree of splits. Pure functions, so the layout rules are testable.

export type Dir = "left" | "right" | "up" | "down";
export type Zone = Dir | "center";
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest share a pane can be squeezed to while resizing. */
export const MIN_SHARE = 0.08;

const pane = (chatId: string): LatticeNode => ({ kind: "pane", chatId });
const split = (dir: "row" | "col", children: LatticeNode[], sizes?: number[]): LatticeNode => ({
  kind: "split",
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length),
});

export function paneIds(n: LatticeNode | null): string[] {
  if (!n) return [];
  return n.kind === "pane" ? [n.chatId] : n.children.flatMap(paneIds);
}

/** Pane rectangles for a container of w×h. */
export function rects(n: LatticeNode | null, w: number, h: number, x = 0, y = 0, out = new Map<string, Rect>()): Map<string, Rect> {
  if (!n) return out;
  if (n.kind === "pane") {
    out.set(n.chatId, { x, y, w, h });
    return out;
  }
  let at = 0;
  n.children.forEach((c, i) => {
    const share = n.sizes[i] ?? 0;
    if (n.dir === "row") rects(c, w * share, h, x + w * at, y, out);
    else rects(c, w, h * share, x, y + h * at, out);
    at += share;
  });
  return out;
}

/** Removes a pane; splits left with one child collapse into it. */
export function remove(n: LatticeNode | null, chatId: string): LatticeNode | null {
  if (!n) return null;
  if (n.kind === "pane") return n.chatId === chatId ? null : n;
  const kept: { c: LatticeNode; s: number }[] = [];
  n.children.forEach((c, i) => {
    const r = remove(c, chatId);
    if (r) kept.push({ c: r, s: n.sizes[i] ?? 0 });
  });
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0]!.c;
  const total = kept.reduce((a, k) => a + k.s, 0) || 1;
  return { ...n, children: kept.map((k) => k.c), sizes: kept.map((k) => k.s / total) };
}

/** Replaces the pane for `chatId` with `fn(pane)`. */
function replace(n: LatticeNode, chatId: string, fn: (p: LatticeNode) => LatticeNode): LatticeNode {
  if (n.kind === "pane") return n.chatId === chatId ? fn(n) : n;
  return { ...n, children: n.children.map((c) => replace(c, chatId, fn)) };
}

/** Puts `chatId` next to `target` on the given side (or swaps them for "center"). */
export function place(root: LatticeNode, chatId: string, target: string, zone: Zone): LatticeNode {
  if (zone === "center") return swap(root, chatId, target);
  const base = remove(root, chatId);
  if (!base) return pane(chatId);
  if (!paneIds(base).includes(target)) return base;
  const dir = zone === "left" || zone === "right" ? "row" : "col";
  const first = zone === "left" || zone === "up";
  return flatten(replace(base, target, (t) => split(dir, first ? [pane(chatId), t] : [t, pane(chatId)])));
}

export function swap(root: LatticeNode, a: string, b: string): LatticeNode {
  if (a === b) return root;
  const go = (n: LatticeNode): LatticeNode =>
    n.kind === "pane" ? (n.chatId === a ? pane(b) : n.chatId === b ? pane(a) : n) : { ...n, children: n.children.map(go) };
  return go(root);
}

/** A split inside a same-direction split merges into its parent, so the tree stays shallow. */
export function flatten(n: LatticeNode): LatticeNode {
  if (n.kind === "pane") return n;
  const children: LatticeNode[] = [];
  const sizes: number[] = [];
  n.children.forEach((c0, i) => {
    const c = flatten(c0);
    const s = n.sizes[i] ?? 0;
    if (c.kind === "split" && c.dir === n.dir) {
      c.children.forEach((cc, j) => {
        children.push(cc);
        sizes.push(s * (c.sizes[j] ?? 0));
      });
    } else {
      children.push(c);
      sizes.push(s);
    }
  });
  return { ...n, children, sizes };
}

/** Adds a chat by splitting the largest pane along its longer side: a self-balancing tiling. */
export function add(root: LatticeNode | null, chatId: string, w = 1600, h = 1000): LatticeNode {
  if (!root) return pane(chatId);
  if (paneIds(root).includes(chatId)) return root;
  let best: { id: string; r: Rect } | null = null;
  for (const [id, r] of rects(root, w, h)) if (!best || r.w * r.h > best.r.w * best.r.h + 1) best = { id, r };
  return place(root, chatId, best!.id, best!.r.w >= best!.r.h * 0.9 ? "right" : "down");
}

/** Brings the tree in line with the chats that should be shown: drops gone ones, adds new ones. */
export function sync(root: LatticeNode | null, chatIds: string[], w?: number, h?: number): LatticeNode | null {
  let next = root;
  for (const id of paneIds(root)) if (!chatIds.includes(id)) next = remove(next, id);
  for (const id of chatIds) next = add(next, id, w, h);
  return next;
}

/** Layout presets (§ Lattice toolbar). Keeps the order of `ids`. */
export function arrange(preset: "grid" | "columns" | "rows" | "main", ids: string[], w = 1600, h = 1000): LatticeNode | null {
  if (!ids.length) return null;
  if (ids.length === 1) return pane(ids[0]!);
  if (preset === "columns") return split("row", ids.map(pane));
  if (preset === "rows") return split("col", ids.map(pane));
  if (preset === "main")
    return split("row", [pane(ids[0]!), ids.length === 2 ? pane(ids[1]!) : split("col", ids.slice(1).map(pane))], [0.6, 0.4]);
  // Grid: as many columns as keeps panes closest to the container's shape.
  const n = ids.length;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * w) / h))));
  const rows: LatticeNode[] = [];
  for (let i = 0; i < n; i += cols) {
    const row = ids.slice(i, i + cols);
    rows.push(row.length === 1 ? pane(row[0]!) : split("row", row.map(pane)));
  }
  return rows.length === 1 ? rows[0]! : split("col", rows);
}

export function equalize(n: LatticeNode | null): LatticeNode | null {
  if (!n || n.kind === "pane") return n;
  return { ...n, sizes: n.children.map(() => 1 / n.children.length), children: n.children.map((c) => equalize(c)!) };
}

/** The nearest pane in a direction, by geometry (what you'd expect when tiled). */
export function neighbour(root: LatticeNode | null, from: string, dir: Dir, w = 1600, h = 1000): string | null {
  const all = rects(root, w, h);
  const a = all.get(from);
  if (!a) return null;
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  let best: { id: string; score: number } | null = null;
  for (const [id, r] of all) {
    if (id === from) continue;
    const ok =
      dir === "left"
        ? r.x + r.w <= a.x + 1
        : dir === "right"
          ? r.x >= a.x + a.w - 1
          : dir === "up"
            ? r.y + r.h <= a.y + 1
            : r.y >= a.y + a.h - 1;
    if (!ok) continue;
    const overlap =
      dir === "left" || dir === "right"
        ? Math.max(0, Math.min(a.y + a.h, r.y + r.h) - Math.max(a.y, r.y))
        : Math.max(0, Math.min(a.x + a.w, r.x + r.w) - Math.max(a.x, r.x));
    const dist = Math.abs(r.x + r.w / 2 - cx) + Math.abs(r.y + r.h / 2 - cy);
    const score = dist - overlap * 2;
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id ?? null;
}

/** Sets the shares at `path` (child indexes from the root) after a gutter drag. */
export function resize(root: LatticeNode, path: number[], sizes: number[]): LatticeNode {
  if (root.kind === "pane") return root;
  if (!path.length) return { ...root, sizes };
  const [i, ...rest] = path;
  return { ...root, children: root.children.map((c, j) => (j === i ? resize(c, rest, sizes) : c)) };
}

/** Moves the boundary between children `i` and `i+1` by `delta` (a share), keeping both above the minimum. */
export function shift(sizes: number[], i: number, delta: number): number[] {
  const a = sizes[i]!;
  const b = sizes[i + 1]!;
  const d = Math.max(MIN_SHARE - a, Math.min(b - MIN_SHARE, delta));
  return sizes.map((s, j) => (j === i ? a + d : j === i + 1 ? b - d : s));
}

/** Which zone of a pane a point is in: the outer quarter on each side, otherwise the centre. */
export function zoneAt(r: Rect, px: number, py: number): Zone {
  const fx = (px - r.x) / r.w;
  const fy = (py - r.y) / r.h;
  const edge = 0.25;
  const dists: [Zone, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["up", fy],
    ["down", 1 - fy],
  ];
  const [zone, d] = dists.sort((p, q) => p[1] - q[1])[0]!;
  return d < edge ? zone : "center";
}
