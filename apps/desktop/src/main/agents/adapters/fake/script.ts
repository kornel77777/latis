import { z } from "zod";
import { AgentEvent } from "@lattiz/shared";

// FakeAdapter script format (SPEC §6.6). One JSON object per line in fixtures/fake/*.jsonl.

const Base = z.object({ delay: z.number().nonnegative().default(0) });

type Step = z.infer<typeof Base> &
  (
    | { event: AgentEvent }
    | { stream: string; chunk: number }
    | { writeFile: { path: string; content: string } }
    | { awaitResponse: string; denied: Step[] }
    | { crash: number }
    | { mcp: { tool: string; args: Record<string, unknown> }; as?: string }
  );

export const ScriptStep: z.ZodType<Step, unknown> = z.lazy(() =>
  z.union([
    Base.extend({ event: AgentEvent }),
    Base.extend({ stream: z.string(), chunk: z.number().int().positive().default(4) }),
    Base.extend({ writeFile: z.object({ path: z.string(), content: z.string() }) }),
    Base.extend({ awaitResponse: z.string(), denied: z.array(ScriptStep).default([]) }),
    Base.extend({ crash: z.number().int() }),
    Base.extend({ mcp: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }), as: z.string().optional() }),
  ]),
);
export type ScriptStep = Step;

export function parseScript(jsonl: string): ScriptStep[] {
  return jsonl
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//"))
    .map((l) => ScriptStep.parse(JSON.parse(l)));
}

export interface ScriptContext {
  userText: string;
  sleep(ms: number): Promise<void>;
  writeFile(relPath: string, content: string): Promise<"created" | "modified">;
  waitForResponse(requestId: string): Promise<"allow" | "deny">;
  exit(code: number): never;
  isInterrupted(): boolean;
  /** Calls a Lattiz workspace tool (the chat must have been given them). Returns the result text. */
  callTool?(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

/** Plays a script, yielding normalised events. Pure apart from what `ctx` does. */
export async function* playScript(steps: ScriptStep[], ctx: ScriptContext): AsyncGenerator<AgentEvent> {
  // {{text}} is the whole message; {{word}} its last word, so scripts can name files after it.
  const word =
    ctx.userText
      .trim()
      .split(/\s+/)
      .at(-1)
      ?.replace(/[^\w-]/g, "") || "file";
  // {{last}} is the message's raw last token (a path); {{name.field}} reads a saved tool result.
  const last = ctx.userText.trim().split(/\s+/).at(-1) ?? "";
  const saved: Record<string, Record<string, unknown>> = {};
  const fill = (s: string) =>
    s
      .replaceAll("{{text}}", ctx.userText)
      .replaceAll("{{word}}", word)
      .replaceAll("{{last}}", last)
      .replace(/\{\{(\w+)\.(\w+)\}\}/g, (all, n: string, f: string) => {
        const v = saved[n]?.[f];
        return v === undefined ? all : typeof v === "string" ? v : JSON.stringify(v);
      });
  const fillDeep = (v: unknown): unknown =>
    typeof v === "string"
      ? fill(v)
      : Array.isArray(v)
        ? v.map(fillDeep)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x)]))
          : v;
  let calls = 0;
  for (const step of steps) {
    if (ctx.isInterrupted()) return;
    if (step.delay) await ctx.sleep(step.delay);
    if ("event" in step) {
      // {{word}} is \w and - only, so substituting inside the JSON is safe.
      const event = JSON.parse(JSON.stringify(step.event).replaceAll("{{word}}", word)) as AgentEvent;
      yield event.type === "message.completed" ? { ...event, text: fill(event.text) } : event;
    } else if ("stream" in step) {
      const text = fill(step.stream);
      for (let i = 0; i < text.length; i += step.chunk) {
        if (ctx.isInterrupted()) return;
        yield { type: "message.delta", text: text.slice(i, i + step.chunk) };
        await ctx.sleep(step.delay || 15);
      }
    } else if ("writeFile" in step) {
      const content = fill(step.writeFile.content);
      const path = fill(step.writeFile.path);
      const change = await ctx.writeFile(path, content);
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      yield {
        type: "file.changed",
        path,
        change,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }],
        additions: lines.length,
        deletions: 0,
      };
    } else if ("awaitResponse" in step) {
      const decision = await ctx.waitForResponse(step.awaitResponse);
      if (decision === "deny") {
        yield* playScript(step.denied, ctx);
        return;
      }
    } else if ("mcp" in step) {
      const id = `mcp-${++calls}`;
      const args = fillDeep(step.mcp.args) as Record<string, unknown>;
      yield { type: "tool.started", id, kind: "mcp", name: `lattiz.${step.mcp.tool}`, input: args };
      const r = ctx.callTool ? await ctx.callTool(step.mcp.tool, args) : { text: "This chat has no workspace tools.", isError: true };
      if (step.as) {
        try {
          saved[step.as] = JSON.parse(r.text) as Record<string, unknown>;
        } catch {
          saved[step.as] = { text: r.text };
        }
      }
      yield { type: "tool.completed", id, status: r.isError ? "error" : "ok", output: r.text };
    } else {
      ctx.exit(step.crash);
    }
  }
}
