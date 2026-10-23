import type { FlowSpec } from "@latis/shared";

// One-click flows (SPEC §11.5). `agent: "auto"` spreads chats across the connected agents.

export const TEMPLATES: { id: string; title: string; description: string; spec: FlowSpec }[] = [
  {
    id: "council",
    title: "Council",
    description: "Four chats argue it out as builder, skeptic, simplifier and user advocate; a synthesiser writes the decision.",
    spec: {
      name: "Council",
      brief: "Decide well. Be concrete and say what you're unsure about.",
      nodes: [
        { id: "start", type: "start", title: "Question" },
        {
          id: "builder",
          type: "chat",
          agent: "auto",
          title: "Builder",
          job: "You are the builder: propose the most practical way to do it.",
        },
        {
          id: "skeptic",
          type: "chat",
          agent: "auto",
          title: "Skeptic",
          job: "You are the skeptic: find what could go wrong and what's unproven.",
        },
        {
          id: "simplifier",
          type: "chat",
          agent: "auto",
          title: "Simplifier",
          job: "You are the simplifier: find the smallest thing that would work.",
        },
        {
          id: "advocate",
          type: "chat",
          agent: "auto",
          title: "User advocate",
          job: "You are the user advocate: say what the people using it need.",
        },
        {
          id: "synth",
          type: "chat",
          agent: "auto",
          title: "Synthesiser",
          job: "Combine the four views into a decision: where they agree, where they disagree, what nobody checked, and your recommendation.",
        },
        { id: "decision", type: "note", title: "Decision" },
      ],
      edges: [
        { from: "start", to: "builder" },
        { from: "start", to: "skeptic" },
        { from: "start", to: "simplifier" },
        { from: "start", to: "advocate" },
        { from: "builder", to: "synth", mode: "wait_all" },
        { from: "skeptic", to: "synth", mode: "wait_all" },
        { from: "simplifier", to: "synth", mode: "wait_all" },
        { from: "advocate", to: "synth", mode: "wait_all" },
        { from: "synth", to: "decision" },
      ],
    },
  },
  {
    id: "review3",
    title: "Review ×3",
    description: "The same input to three reviewers: correctness, simplicity and readability.",
    spec: {
      name: "Review ×3",
      nodes: [
        { id: "start", type: "start", title: "What to review" },
        {
          id: "correct",
          type: "chat",
          agent: "auto",
          title: "Correctness",
          job: "Review for correctness: bugs, edge cases, wrong assumptions.",
        },
        {
          id: "simple",
          type: "chat",
          agent: "auto",
          title: "Simplicity",
          job: "Review for simplicity: what can be removed or made plainer.",
        },
        { id: "read", type: "chat", agent: "auto", title: "Readability", job: "Review for readability: naming, structure, comments." },
        { id: "out", type: "note", title: "Reviews" },
      ],
      edges: [
        { from: "start", to: "correct" },
        { from: "start", to: "simple" },
        { from: "start", to: "read" },
        { from: "correct", to: "out" },
        { from: "simple", to: "out" },
        { from: "read", to: "out" },
      ],
    },
  },
  {
    id: "pipeline",
    title: "Pipeline",
    description: "Research, then write, then edit; the result lands in a note.",
    spec: {
      name: "Pipeline",
      nodes: [
        { id: "start", type: "start", title: "Topic" },
        { id: "research", type: "chat", agent: "auto", title: "Research", job: "Find the facts that matter, with sources." },
        { id: "write", type: "chat", agent: "auto", title: "Write", job: "Write it up from the research." },
        { id: "edit", type: "chat", agent: "auto", title: "Edit", job: "Edit for clarity and length. Return only the final text." },
        { id: "out", type: "note", title: "Result" },
      ],
      edges: [
        { from: "start", to: "research" },
        { from: "research", to: "write" },
        { from: "write", to: "edit" },
        { from: "edit", to: "out" },
      ],
    },
  },
  {
    id: "team",
    title: "Team",
    description: "One task per line, shared among three workers as each becomes free; results collect in a card.",
    spec: {
      name: "Team",
      nodes: [
        { id: "start", type: "start", title: "Tasks (one per line)", oneTaskPerLine: true },
        { id: "w1", type: "chat", agent: "auto", title: "Worker 1", job: "Do the task you're given and report briefly." },
        { id: "w2", type: "chat", agent: "auto", title: "Worker 2", job: "Do the task you're given and report briefly." },
        { id: "w3", type: "chat", agent: "auto", title: "Worker 3", job: "Do the task you're given and report briefly." },
        { id: "results", type: "card", gate: "results", title: "Results" },
      ],
      edges: [
        { from: "start", to: "w1", mode: "free" },
        { from: "start", to: "w2", mode: "free" },
        { from: "start", to: "w3", mode: "free" },
        { from: "w1", to: "results" },
        { from: "w2", to: "results" },
        { from: "w3", to: "results" },
      ],
    },
  },
  {
    id: "digest",
    title: "Daily digest",
    description: "Every morning at 08:00 two watchers check things, a writer sums up, and you approve it into a note.",
    spec: {
      name: "Daily digest",
      schedule: { every: "daily", at: "08:00" },
      nodes: [
        { id: "start", type: "start", title: "Each morning", input: "Check what changed since yesterday." },
        { id: "watch1", type: "chat", agent: "auto", title: "Watcher 1", job: "Check what changed and list what matters, briefly." },
        { id: "watch2", type: "chat", agent: "auto", title: "Watcher 2", job: "Check what changed and list what matters, briefly." },
        { id: "writer", type: "chat", agent: "auto", title: "Writer", job: "Write a short morning digest from the watchers' notes." },
        { id: "out", type: "note", title: "Digest" },
      ],
      edges: [
        { from: "start", to: "watch1" },
        { from: "start", to: "watch2" },
        { from: "watch1", to: "writer", mode: "wait_all" },
        { from: "watch2", to: "writer", mode: "wait_all" },
        { from: "writer", to: "out", mode: "approval" },
      ],
    },
  },
];
