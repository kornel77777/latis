import { normalise } from "./keys";
import type { Command } from "./registry";

// Pure helpers for command bindings (no store), so they're unit-testable.

/** A command's chords after the user's overrides. */
export function bindingsOf(cmd: Command, overrides: Record<string, string[]> | undefined): string[] {
  return (overrides?.[cmd.id] ?? cmd.keys ?? []).map(normalise);
}

/** Commands that share a chord in the same scope (or with a global one). */
export function conflicts(list: Command[], overrides: Record<string, string[]> | undefined): Map<string, string[]> {
  const byChord = new Map<string, Command[]>();
  for (const c of list) for (const k of bindingsOf(c, overrides)) byChord.set(k, [...(byChord.get(k) ?? []), c]);
  const out = new Map<string, string[]>();
  for (const [chord, cs] of byChord) {
    const clash = cs.some((a, i) =>
      cs.some(
        (b, j) =>
          j > i &&
          ((a.scope ?? "global") === (b.scope ?? "global") || (a.scope ?? "global") === "global" || (b.scope ?? "global") === "global"),
      ),
    );
    if (clash) for (const c of cs) out.set(c.id, [...(out.get(c.id) ?? []), chord]);
  }
  return out;
}
