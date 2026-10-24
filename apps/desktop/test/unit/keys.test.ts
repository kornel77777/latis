import { describe, expect, it } from "vitest";
import { chordOf, display, isBare, normalise } from "../../src/renderer/commands/keys";
import { bindingsOf, conflicts } from "../../src/renderer/commands/bindings";
import type { Command } from "../../src/renderer/commands/registry";

const ev = (o: Partial<KeyboardEvent> & { code: string; key: string }) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe("key chords", () => {
  it("reads events the same way on every layout (codes for letters and digits)", () => {
    expect(chordOf(ev({ key: "k", code: "KeyK", metaKey: true }), true)).toBe("Mod+K");
    expect(chordOf(ev({ key: "k", code: "KeyK", ctrlKey: true }), false)).toBe("Mod+K");
    expect(chordOf(ev({ key: "!", code: "Digit1", shiftKey: true }), true)).toBe("Shift+1");
    expect(chordOf(ev({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, altKey: true }), true)).toBe("Mod+Alt+ArrowLeft");
    expect(chordOf(ev({ key: "j", code: "KeyJ", ctrlKey: true }), true)).toBe("Ctrl+J");
    expect(chordOf(ev({ key: "Shift", code: "ShiftLeft", shiftKey: true }), true)).toBeNull();
  });

  it("normalises and displays", () => {
    expect(normalise("shift+cmd+r")).toBe("Mod+Shift+R");
    expect(display("Mod+Shift+R", true)).toBe("⌘⇧R");
    expect(display("Mod+Shift+R", false)).toBe("Ctrl+Shift+R");
    expect(display("Mod+Alt+ArrowLeft", true)).toBe("⌘⌥←");
    expect(isBare("N")).toBe(true);
    expect(isBare("Shift+1")).toBe(true);
    expect(isBare("Mod+K")).toBe(false);
  });

  it("applies overrides and spots conflicts within a scope (or with global commands)", () => {
    const cmds: Command[] = [
      { id: "a", title: "A", category: "General", keys: ["Mod+K"], run: () => undefined },
      { id: "b", title: "B", category: "Canvas", keys: ["N"], scope: "canvas", run: () => undefined },
      { id: "c", title: "C", category: "Lattice", keys: ["N"], scope: "lattice", run: () => undefined },
    ];
    expect(bindingsOf(cmds[0]!, { a: ["mod+j"] })).toEqual(["Mod+J"]);
    expect(conflicts(cmds, {}).size).toBe(0); // canvas N and lattice N never meet
    expect([...conflicts(cmds, { b: ["Mod+K"] }).keys()].sort()).toEqual(["a", "b"]);
  });
});
