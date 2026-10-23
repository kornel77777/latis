import { z } from "zod";
import { AgentEvent } from "@latis/shared";

// FakeAdapter script format (SPEC §6.6). One JSON object per line in fixtures/fake/*.jsonl.

const Base = z.object({ delay: z.number().nonnegative().default(0) });

type Step = z.infer<typeof Base> &
  (
    | { event: AgentEvent }
    | { stream: string; chunk: number }
    | { writeFile: { path: string; content: string } }
    | { awaitResponse: string; denied: Step[] }
    | { crash: number }
  );

export const ScriptStep: z.ZodType<Step, unknown> = z.lazy(() =>
  z.union([
    Base.extend({ event: AgentEvent }),
    Base.extend({ stream: z.string(), chunk: z.number().int().positive().default(4) }),
    Base.extend({ writeFile: z.object({ path: z.string(), content: z.string() }) }),
    Base.extend({ awaitResponse: z.string(), denied: z.array(ScriptStep).default([]) }),
    Base.extend({ crash: z.number().int() }),
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
}

/** Plays a script, yielding normalised events. Pure apart from what `ctx` does. */
export async function* playScript(steps: ScriptStep[], ctx: ScriptContext): AsyncGenerator<AgentEvent> {
  const fill = (s: string) => s.replaceAll("{{text}}", ctx.userText);
  for (const step of steps) {
    if (ctx.isInterrupted()) return;
    if (step.delay) await ctx.sleep(step.delay);
    if ("event" in step) {
      yield step.event.type === "message.completed" ? { ...step.event, text: fill(step.event.text) } : step.event;
    } else if ("stream" in step) {
      const text = fill(step.stream);
      for (let i = 0; i < text.length; i += step.chunk) {
        if (ctx.isInterrupted()) return;
        yield { type: "message.delta", text: text.slice(i, i + step.chunk) };
        await ctx.sleep(step.delay || 15);
      }
    } else if ("writeFile" in step) {
      const content = fill(step.writeFile.content);
      const change = await ctx.writeFile(step.writeFile.path, content);
      const lines = content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      yield {
        type: "file.changed",
        path: step.writeFile.path,
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
    } else {
      ctx.exit(step.crash);
    }
  }
}
