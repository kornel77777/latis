import { describe, expect, it } from "vitest";
import type { LatticeNode } from "@latis/shared";
import {
  add,
  arrange,
  equalize,
  neighbour,
  paneIds,
  place,
  rects,
  remove,
  shift,
  swap,
  sync,
  zoneAt,
} from "../../src/renderer/lattice/tree";

const shape = (n: LatticeNode | null): unknown => (!n ? null : n.kind === "pane" ? n.chatId : { [n.dir]: n.children.map(shape) });

describe("lattice", () => {
  it("adds chats by splitting the largest pane along its longer side", () => {
    let t: LatticeNode | null = null;
    for (const id of ["a", "b", "c", "d"]) t = add(t, id, 1600, 1000);
    // a|b, then the widest (a) splits down… ending in a balanced 2×2.
    expect(shape(t)).toEqual({ row: [{ col: ["a", "c"] }, { col: ["b", "d"] }] });
    const r = rects(t, 1600, 1000);
    expect([...r.values()].every((x) => x.w === 800 && x.h === 500)).toBe(true);
  });

  it("removes panes and collapses single-child splits, keeping shares summing to 1", () => {
    let t = arrange("grid", ["a", "b", "c", "d"], 1000, 1000)!;
    t = remove(t, "b")!;
    t = remove(t, "d")!;
    expect(shape(t)).toEqual({ col: ["a", "c"] });
    expect(remove(remove(t, "a"), "c")).toBeNull();
  });

  it("sync drops chats that are gone and adds new ones", () => {
    const t = sync(arrange("columns", ["a", "b"])!, ["b", "c"]);
    expect(paneIds(t).sort()).toEqual(["b", "c"]);
  });

  it("presets: columns, rows, main + stack, and a grid shaped like the container", () => {
    expect(shape(arrange("columns", ["a", "b", "c"]))).toEqual({ row: ["a", "b", "c"] });
    expect(shape(arrange("rows", ["a", "b"]))).toEqual({ col: ["a", "b"] });
    expect(shape(arrange("main", ["a", "b", "c"]))).toEqual({ row: ["a", { col: ["b", "c"] }] });
    expect(shape(arrange("grid", ["a", "b", "c", "d", "e", "f"], 1600, 1000))).toEqual({
      col: [{ row: ["a", "b", "c"] }, { row: ["d", "e", "f"] }],
    });
    // A tall container gets one column; a square one a 2×2.
    expect(shape(arrange("grid", ["a", "b", "c", "d"], 800, 1600))).toEqual({ col: ["a", "b", "c", "d"] });
    expect(shape(arrange("grid", ["a", "b", "c", "d"], 1000, 1000))).toEqual({ col: [{ row: ["a", "b"] }, { row: ["c", "d"] }] });
  });

  it("drops beside a pane (edges) or swaps (centre), flattening same-direction splits", () => {
    const t = arrange("columns", ["a", "b", "c"])!;
    expect(shape(place(t, "c", "a", "left"))).toEqual({ row: ["c", "a", "b"] });
    expect(shape(place(t, "c", "a", "down"))).toEqual({ row: [{ col: ["a", "c"] }, "b"] });
    expect(shape(place(t, "a", "c", "center"))).toEqual({ row: ["c", "b", "a"] });
    expect(shape(swap(t, "a", "b"))).toEqual({ row: ["b", "a", "c"] });
  });

  it("finds neighbours by geometry", () => {
    const t = arrange("grid", ["a", "b", "c", "d"], 1000, 1000)!;
    expect(neighbour(t, "a", "right", 1000, 1000)).toBe("b");
    expect(neighbour(t, "a", "down", 1000, 1000)).toBe("c");
    expect(neighbour(t, "d", "left", 1000, 1000)).toBe("c");
    expect(neighbour(t, "a", "up", 1000, 1000)).toBeNull();
  });

  it("resizing keeps every pane above the minimum; equalize resets", () => {
    expect(shift([0.5, 0.5], 0, 0.9)).toEqual([expect.closeTo(0.92), expect.closeTo(0.08)]);
    expect(shift([0.3, 0.3, 0.4], 1, -0.1)).toEqual([0.3, expect.closeTo(0.2), expect.closeTo(0.5)]);
    const t = equalize({
      kind: "split",
      dir: "row",
      sizes: [0.9, 0.1],
      children: [
        { kind: "pane", chatId: "a" },
        { kind: "pane", chatId: "b" },
      ],
    });
    expect(t && t.kind === "split" && t.sizes).toEqual([0.5, 0.5]);
  });

  it("drop zones: outer quarter of each side, centre otherwise", () => {
    const r = { x: 0, y: 0, w: 400, h: 400 };
    expect(zoneAt(r, 20, 200)).toBe("left");
    expect(zoneAt(r, 390, 200)).toBe("right");
    expect(zoneAt(r, 200, 10)).toBe("up");
    expect(zoneAt(r, 200, 395)).toBe("down");
    expect(zoneAt(r, 200, 200)).toBe("center");
  });
});
