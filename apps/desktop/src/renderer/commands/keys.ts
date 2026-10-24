// Key chords for commands: "Mod+Shift+R", "Ctrl+J", "Alt+ArrowLeft", "N".
// `Mod` is ⌘ on macOS and Ctrl elsewhere, so one binding works on every OS.

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

const ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof ORDER)[number];

/** The non-modifier key of an event, normalised (letters upper-case, `code` for digits/punctuation so Shift doesn't change them). */
function keyOf(e: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (["Meta", "Control", "Alt", "Shift", "OS"].includes(e.key)) return null;
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  const byCode: Record<string, string> = {
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Space: "Space",
  };
  if (byCode[e.code]) return byCode[e.code]!;
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** The chord an event represents, or null for a lone modifier. */
export function chordOf(
  e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  mac = isMac,
): string | null {
  const key = keyOf(e);
  if (!key) return null;
  const mods: Modifier[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (mac && e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

/** Normalises a written chord ("shift+mod+r" → "Mod+Shift+R"). */
export function normalise(chord: string): string {
  const parts = chord
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = ORDER.filter((m) =>
    parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === "Mod" && /^(cmd|command|meta)$/i.test(p))),
  );
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join("+");
}

const SYMBOLS_MAC: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  Space: "Space",
};

/** How a chord reads on this OS: ⌘⇧R on macOS, Ctrl+Shift+R elsewhere. */
export function display(chord: string, mac = isMac): string {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const k = KEY_NAMES[key] ?? key;
  if (mac) return parts.map((p) => SYMBOLS_MAC[p] ?? p).join("") + k;
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), k].join("+");
}

/** Chords without Mod/Ctrl/Alt type text, so they only fire outside text fields. */
export function isBare(chord: string): boolean {
  return !/^(Mod|Ctrl|Alt)\+/.test(chord) && !chord.includes("+Mod") && !/(^|\+)(Ctrl|Alt)\+/.test(chord);
}
