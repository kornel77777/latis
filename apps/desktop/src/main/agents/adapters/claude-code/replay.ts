import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CanUseTool, ModelInfo, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "./index";

// Test double for the SDK's query(): replays recordings from fixtures/claude-code/*.jsonl.
// Used by unit tests and, with LATIS_CLAUDE_REPLAY=<dir>, by e2e tests driving the real UI.
// It pauses at each recorded permission prompt until the app answers, like the real CLI.

type Line = { kind: string; data: unknown };

interface Recording {
  turns: Line[][];
  models: ModelInfo[];
}

export function loadRecording(file: string, cwd: string): Recording {
  const lines = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l.replaceAll("<cwd>", cwd)) as Line);
  const turns: Line[][] = [[]];
  let models: ModelInfo[] = [];
  for (const l of lines) {
    if (l.kind === "supported_models") models = l.data as ModelInfo[];
    else turns.at(-1)!.push(l);
    if (l.kind === "message" && (l.data as SDKMessage).type === "result") turns.push([]);
  }
  return { turns: turns.filter((t) => t.length), models };
}

/** Replays one recording per message: the message text names the fixture (e.g. "please /ask-question"). */
export function createReplayQuery(dir: string, fallback = "allow-write-bash"): QueryFn {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));

  return (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const cwd = options.cwd ?? process.cwd();
    let current: { rec: Recording; turn: number } | null = null;
    const pick = (text: string) => {
      const named = names.find((n) => text.includes(`/${n}`));
      if (named || !current || current.turn >= current.rec.turns.length) {
        current = { rec: loadRecording(join(dir, `${named ?? fallback}.jsonl`), cwd), turn: 0 };
      }
      return current.rec.turns[current.turn++] ?? [];
    };
    let interrupted = false;
    let closed = false;

    async function* run(): AsyncGenerator<SDKMessage> {
      for await (const user of prompt) {
        if (closed) return;
        // A steer joins the running turn in the real CLI; recordings have nothing to play for it.
        if (user.priority === "next") continue;
        interrupted = false;
        const content = user.message.content;
        const text = typeof content === "string" ? content : content.map((b) => ("text" in b ? b.text : "")).join(" ");
        for (const l of pick(text)) {
          if (closed) return;
          if (interrupted) {
            yield {
              type: "result",
              subtype: "error_during_execution",
              is_error: true,
              duration_ms: 1,
              total_cost_usd: 0,
              usage: { input_tokens: 0, output_tokens: 0 },
            } as unknown as SDKMessage;
            break;
          }
          if (l.kind === "can_use_tool") {
            const d = l.data as {
              toolName: string;
              input: Record<string, unknown>;
              toolUseID: string;
              title?: string;
              displayName?: string;
            };
            const ctx = {
              signal: new AbortController().signal,
              toolUseID: d.toolUseID,
              suggestions: [],
              title: d.title,
              displayName: d.displayName,
            };
            await options.canUseTool!(d.toolName, d.input, ctx as unknown as Parameters<CanUseTool>[2]);
          } else if (l.kind === "message") {
            // Pace like a live stream so the UI's streaming paths are exercised.
            await new Promise((r) => setTimeout(r, (l.data as SDKMessage).type === "stream_event" ? 8 : 25));
            yield l.data as SDKMessage;
          }
        }
      }
    }

    const gen = run();
    const models = () => current?.rec.models ?? loadRecording(join(dir, `${fallback}.jsonl`), cwd).models;
    return Object.assign(gen, {
      interrupt: async () => {
        interrupted = true;
        return { still_queued: [] };
      },
      close: () => {
        closed = true;
      },
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      applyFlagSettings: async () => undefined,
      supportedModels: async () => models(),
      accountInfo: async () => ({ email: "replay@example.com", subscriptionType: "replay" }),
    }) as unknown as Query;
  }) as unknown as QueryFn;
}
