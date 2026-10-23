import { describe, expect, it } from "vitest";
import { claudeWindows } from "../../src/main/agents/adapters/claude-code/mapper";
import { codexWindows } from "../../src/main/agents/adapters/codex/mapper";
import { openTodos } from "../../src/main/handoff";

describe("usage windows", () => {
  it("reads Claude's unified windows (utilisation 0–1, seconds)", () => {
    const w = claudeWindows({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.43, resetsAt: 1792737600 }, seven_day: { utilization: 0.355, resetsAt: 1792846800 } },
    });
    expect(w).toEqual([
      { id: "five_hour", label: "5h", usedPct: 43, resetsAt: new Date(1792737600_000).toISOString() },
      { id: "seven_day", label: "7d", usedPct: 36, resetsAt: new Date(1792846800_000).toISOString() },
    ]);
    expect(claudeWindows({ status: "allowed" })).toEqual([]);
  });

  it("reads Codex's primary and secondary windows, labelled by length", () => {
    const w = codexWindows({
      primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1792747887 },
      secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: null },
    });
    expect(w.map((x) => [x.label, x.usedPct, Boolean(x.resetsAt)])).toEqual([
      ["5h", 12, true],
      ["7d", 3, false],
    ]);
    expect(codexWindows(null)).toEqual([]);
  });
});

describe("handoff", () => {
  it("collects unchecked tasks and TODO lines, without duplicates", () => {
    expect(
      openTodos([
        "- [x] Cart total\n- [ ] Apply discount codes\n* [ ] Tests",
        "TODO: wire the checkout button\nRemaining - docs\n- [ ] Tests",
      ]),
    ).toEqual(["Apply discount codes", "Tests", "wire the checkout button", "docs"]);
  });
});
