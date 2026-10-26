// Records a real Claude Agent SDK stream into fixtures/claude-code/<name>.jsonl (SPEC §0.2, §16).
// Usage: node scripts/record-claude-stream.mjs <name> "<prompt>" [--deny] [--model haiku] [--mode plan] [--then "<second prompt>"]
//          [--deny-matching "<regex>"]   PreToolUse hook on Bash, as Latis uses for the always-ask list; denies matching commands
// Spends real tokens on whatever account Claude Code is signed in with. Paths and identities are scrubbed.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const [name, prompt, ...rest] = process.argv.slice(2);
if (!name || !prompt) throw new Error("usage: record-claude-stream.mjs <name> <prompt> [--deny] [--model m] [--then p2]");
const flag = (f) => rest.includes(f);
const arg = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
const cwd = mkdtempSync(join(process.env.LATIS_TEST_TMP ?? tmpdir(), "latis-rec-"));
writeFileSync(join(cwd, "README.md"), "# Recording sandbox\n");

const prompts = [prompt, arg("--then")].filter(Boolean);
let release;
const turnDone = () => new Promise((r) => (release = r));

async function* input() {
  for (const p of prompts) {
    yield { type: "user", message: { role: "user", content: p }, parent_tool_use_id: null };
    await turnDone();
  }
}

const lines = [];
const scrub = (s) => s.replaceAll(cwd, "<cwd>").replaceAll(homedir(), "<home>");
const record = (kind, data) => lines.push(scrub(JSON.stringify({ kind, data })));

const q = query({
  prompt: input(),
  options: {
    cwd,
    model: arg("--model") ?? "haiku",
    includePartialMessages: true,
    permissionMode: arg("--mode") ?? "default",
    ...(arg("--mode") === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
    settingSources: [],
    ...(arg("--deny-matching") && {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              async (hookInput) => {
                const deny = new RegExp(arg("--deny-matching")).test(hookInput.tool_input.command);
                record("pre_tool_use", { toolName: hookInput.tool_name, input: hookInput.tool_input, toolUseID: hookInput.tool_use_id });
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    ...(deny && { permissionDecision: "deny", permissionDecisionReason: "The user denied this." }),
                  },
                };
              },
            ],
          },
        ],
      },
    }),
    canUseTool: async (toolName, toolInput, opts) => {
      record("can_use_tool", {
        toolName,
        input: toolInput,
        title: opts.title,
        displayName: opts.displayName,
        decisionReason: opts.decisionReason,
        toolUseID: opts.toolUseID,
        suggestions: opts.suggestions,
      });
      if (toolName === "AskUserQuestion") {
        // Answer every question with its first option, as the SDK expects: question text -> answer.
        const answers = Object.fromEntries(toolInput.questions.map((q) => [q.question, q.options[0].label]));
        return { behavior: "allow", updatedInput: { ...toolInput, answers } };
      }
      return flag("--deny") ? { behavior: "deny", message: "User denied in recording" } : { behavior: "allow", updatedInput: toolInput };
    },
  },
});

const models = await q.supportedModels();
record(
  "supported_models",
  models.map(({ value, displayName, supportsEffort, supportedEffortLevels }) => ({
    value,
    displayName,
    supportsEffort,
    supportedEffortLevels,
  })),
);

for await (const m of q) {
  record("message", m);
  if (m.type === "result") {
    release?.();
    if (lines.filter((l) => l.includes('"type":"result"')).length >= prompts.length) break;
  }
}
q.close();
const out = new URL(`../../../fixtures/claude-code/${name}.jsonl`, import.meta.url);
writeFileSync(out, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} lines to ${out.pathname}`);
