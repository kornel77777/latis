import { buildTranscript, type ChatSummary, type FileDiff } from "@lattiz/shared";
import type { WorkspaceStore } from "./store/workspace";

// Handoff (SPEC §9.11): a brief for the next agent, built from what Lattiz already has: the first
// message, the outgoing agent's latest report, the files changed and the open TODOs.

const REPORT_CAP = 4000;

function cap(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Unchecked task-list items and TODO lines from the agent's own words and plans. */
export function openTodos(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts)
    for (const line of t.split("\n")) {
      const m = /^\s*[-*]\s+\[ \]\s+(.+)$/.exec(line) ?? /^\s*(?:[-*]\s+)?(?:TODO|Next|Remaining)\s*[:-]\s*(.+)$/i.exec(line);
      if (m && !out.includes(m[1]!.trim())) out.push(m[1]!.trim());
    }
  return out.slice(0, 12);
}

export function buildBrief(store: WorkspaceStore, chat: ChatSummary, agentName: string, changes: FileDiff[]): string {
  const t = store.transcript(chat.id);
  const items = buildTranscript(t.turns, t.events);
  const goal = t.turns[0]?.userText.trim() ?? "(no message yet)";
  const replies = items.flatMap((i) => (i.kind === "assistant" && i.text.trim() ? [i.text.trim()] : []));
  const plans = items.flatMap((i) => (i.kind === "plan" ? [i.markdown] : []));
  const last = replies.at(-1);
  const later = t.turns
    .slice(1)
    .map((x) => x.userText.trim())
    .filter(Boolean);
  const stat = changes.map((f) => `- ${f.change} \`${f.path}\` (+${f.additions} −${f.deletions})`);
  const todos = openTodos([...plans, ...(last ? [last] : [])]);

  const parts = [
    `# Continuing from ${agentName}`,
    `You're picking up a task another coding agent (${agentName}) was working on in this folder${chat.worktree && !chat.worktree.removed ? ` (branch \`${chat.worktree.branch}\`)` : ""}. It had to stop, so carry on from where it left off.`,
    `## Original goal\n${goal}`,
    ...(later.length
      ? [`## Later instructions from the user\n${later.map((l) => `- ${cap(l.replace(/\n+/g, " "), 300)}`).join("\n")}`]
      : []),
    last
      ? `## What was done (${agentName}'s last report)\n${cap(last, REPORT_CAP)}`
      : `## What was done\n${agentName} didn't report back. Start by looking at the changed files below and summarise what's done before continuing.`,
    `## Files changed so far\n${stat.length ? stat.join("\n") : "No file changes yet."}`,
    `## Open TODOs\n${todos.length ? todos.map((x) => `- [ ] ${x}`).join("\n") : "None listed. Work out what's left from the goal and the changes."}`,
    "## What to do now\nCheck the current state of the files first (don't redo finished work), then finish the task and report what you changed.",
  ];
  return parts.join("\n\n");
}
