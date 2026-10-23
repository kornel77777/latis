import { describe, expect, it } from "vitest";
import { fuzzyPositions, fuzzyScore } from "../../src/renderer/palette/fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences and rejects non-matches", () => {
    expect(fuzzyScore("ntc", "New terminal chat")).not.toBeNull();
    expect(fuzzyScore("xyz", "New chat")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("ranks prefixes, word starts and runs above scattered matches", () => {
    const rank = (q: string, items: string[]) => [...items].sort((a, b) => (fuzzyScore(q, b) ?? -1e9) - (fuzzyScore(q, a) ?? -1e9));
    expect(rank("new", ["Toggle theme: dark → new", "New note", "Review changes"])[0]).toBe("New note");
    expect(rank("rc", ["src/router.ts", "Review changes", "Re-check agents"]).at(-1)).toBe("src/router.ts");
    expect(rank("revch", ["Re-check agents", "Review changes"])[0]).toBe("Review changes");
    expect(rank("pricing", ["src/pages/pricing.tsx", "Pricing page", "Reprice things"])[0]).toBe("Pricing page");
  });

  it("returns the matched positions", () => {
    expect(fuzzyPositions("nn", "New note")).toEqual([0, 4]);
  });
});
