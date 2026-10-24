import { useEffect } from "react";
import { useWorkspace } from "../stores/workspace";
import { bindingsOf } from "./bindings";
import { chordOf, isBare, isMac } from "./keys";

export { bindingsOf, conflicts } from "./bindings";

// Every action Latis can do from the keyboard or the palette is a command (Settings → Commands).
// Defaults live with the command; the user's overrides live in prefs.keybindings.

export type Scope = "global" | "canvas" | "lattice";

export interface Command {
  id: string;
  title: string;
  category: "General" | "Create" | "Chat" | "Canvas" | "Lattice" | "Navigate";
  /** Default chords, e.g. ["Mod+K"]. */
  keys?: string[];
  /** global: anywhere; canvas/lattice: only in that view, and never while typing. */
  scope?: Scope;
  /** Extra condition (a chat must be selected, …). */
  when?: () => boolean;
  run: () => void;
  /** Shown in ⌘K (default true). */
  palette?: boolean;
  hint?: string;
}

/** What the canvas and the lattice let commands do; each view fills its part while mounted. */
export const surfaces: {
  canvas: null | {
    fitAll(): void;
    fitSelection(): void;
    zoomIn(): void;
    zoomOut(): void;
    zoomReset(): void;
    /** A point in the middle of the visible canvas, for new notes and cards. */
    center(): { x: number; y: number };
  };
  lattice: null | {
    focus(dir: "left" | "right" | "up" | "down"): void;
    move(dir: "left" | "right" | "up" | "down"): void;
    toggleMaximize(): void;
    closePane(): void;
    arrange(preset: "grid" | "columns" | "rows" | "main"): void;
    equalize(): void;
  };
} = { canvas: null, lattice: null };

let commands: Command[] = [];

export function setCommands(list: Command[]): void {
  commands = list;
}

export function allCommands(): Command[] {
  return commands;
}

function typing(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable=true], [contenteditable='']"));
}

/** A focused control (button, link, menu item…) owns Enter, Space and plain keys. Canvas nodes don't count. */
function onControl(target: EventTarget | null): boolean {
  return Boolean(
    (target as HTMLElement | null)?.closest?.(
      "button, a[href], [role=menuitem], [role=option], [role=tab], [role=radio], [role=checkbox], [role=slider], [role=listbox]",
    ),
  );
}

function scopeActive(scope: Scope): boolean {
  if (scope === "global") return true;
  const s = useWorkspace.getState();
  // A dialog, menu or the palette has the keyboard.
  if (document.querySelector("[role=dialog], [role=menu]")) return false;
  if (s.activeView) return false;
  return (s.prefs?.layoutMode ?? "canvas") === scope;
}

/** Runs a command by id (palette, buttons, tests). */
export function runCommand(id: string): boolean {
  const c = commands.find((x) => x.id === id);
  if (!c || (c.when && !c.when())) return false;
  c.run();
  return true;
}

/** The single keyboard dispatcher for commands. */
export function useCommandKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const first = chordOf(e);
      if (!first) return;
      const overrides = useWorkspace.getState().prefs?.keybindings;
      const isTyping = typing(e.target);
      // On macOS, a Ctrl chord nothing claims works like the ⌘ one (Ctrl+` or ⌘` both open the dock).
      const claimed = commands.some((c) => bindingsOf(c, overrides).includes(first));
      const chord = !claimed && isMac && /^Ctrl\+/.test(first) && !first.includes("Mod+") ? first.replace(/^Ctrl\+/, "Mod+") : first;
      for (const c of commands) {
        if (!bindingsOf(c, overrides).includes(chord)) continue;
        const scope = c.scope ?? "global";
        // Plain keys type text; view commands leave text fields alone entirely.
        if (isTyping && (isBare(chord) || scope !== "global")) continue;
        if (isBare(chord) && onControl(e.target)) continue;
        if (!scopeActive(scope) || (c.when && !c.when())) continue;
        e.preventDefault();
        c.run();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
