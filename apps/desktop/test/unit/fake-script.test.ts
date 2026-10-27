import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@lattiz/shared";
import { parseScript, playScript, type ScriptContext } from "../../src/main/agents/adapters/fake/script";

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/fake/${name}.jsonl`, import.meta.url), "utf8");

function ctx(decision: "allow" | "deny", files: Record<string, string> = {}): ScriptContext & { exited?: number } {
  const c: ScriptContext & { exited?: number } = {
    userText: "ship it",
    sleep: async () => {},
    writeFile: async (p, content) => {
      const existed = p in files;
      files[p] = content;
      return existed ? "modified" : "created";
    },
    waitForResponse: async () => decision,
    exit: (code) => {
      c.exited = code;
      throw new Error("exit");
    },
    isInterrupted: () => false,
  };
  return c;
}

async function collect(steps: ReturnType<typeof parseScript>, c: ScriptContext) {
  const out: AgentEvent[] = [];
  try {
    for await (const e of playScript(steps, c)) out.push(e);
  } catch (err) {
    if ((err as Error).message !== "exit") throw err;
  }
  return out;
}

describe("FakeAdapter scripts", () => {
  it("every fixture parses", () => {
    for (const name of ["demo", "crash", "ask"]) expect(parseScript(fixture(name)).length).toBeGreaterThan(0);
  });

  it("demo: allow path edits a file and completes", async () => {
    const files: Record<string, string> = {};
    const events = await collect(parseScript(fixture("demo")), ctx("allow", files));
    const text = events.flatMap((e) => (e.type === "message.delta" ? [e.text] : [])).join("");
    expect(text).toContain('To do "ship it"');
    expect(events.find((e) => e.type === "file.changed")).toMatchObject({
      path: "notes/lattiz-demo.md",
      change: "created",
      additions: 3,
      hunks: [{ lines: ["+# Demo", "+", "+Requested: ship it"] }],
    });
    expect(files["notes/lattiz-demo.md"]).toContain("Requested: ship it");
    expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "ok" });
  });

  it("demo: deny path changes nothing", async () => {
    const files: Record<string, string> = {};
    const events = await collect(parseScript(fixture("demo")), ctx("deny", files));
    expect(Object.keys(files)).toHaveLength(0);
    expect(events).toContainEqual({ type: "tool.completed", id: "p1", status: "denied" });
    expect(events.at(-1)).toMatchObject({ type: "turn.completed" });
  });

  it("crash: exits with the scripted code", async () => {
    const c = ctx("allow");
    await collect(parseScript(fixture("crash")), c);
    expect(c.exited).toBe(3);
  });

  it("rejects malformed lines", () => {
    expect(() => parseScript('{"delay":1,"event":{"type":"bogus"}}')).toThrow();
  });
});
