// Fuzzy matching for the command palette (§8.8): every query character in order,
// scored up for runs, word starts and an exact prefix. null = no match.

const isWordStart = (text: string, i: number) =>
  i === 0 || /[\s/_.\-:·]/.test(text[i - 1]!) || (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") {
      run = 0;
      continue;
    }
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    run = found === ti ? run + 1 : 0;
    score += 1 + run * 2 + (isWordStart(text, found) ? 3 : 0) - Math.min(found - ti, 5) * 0.2;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 10;
  else if (t.includes(q)) score += 5;
  return score - text.length * 0.01;
}

/** Character positions to highlight for a match (same walk as fuzzyScore). */
export function fuzzyPositions(query: string, text: string): number[] {
  const t = text.toLowerCase();
  const out: number[] = [];
  let ti = 0;
  for (const ch of query.trim().toLowerCase()) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return [];
    out.push(found);
    ti = found + 1;
  }
  return out;
}
