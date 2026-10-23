# Latis

Mission control for your coding agents: run Claude Code, Codex, Gemini and others side by side on one canvas, then review and land their work safely.

Status: **M3**. Each chat can work in its own git worktree; every turn is checkpointed (undo/redo, timeline); a Review Inbox reviews diffs hunk by hunk; merges are dry-run first. Also: Claude Code, Codex, Gemini CLI (and any ACP agent or terminal CLI added by a manifest) side by side; steering and a message queue; an Inbox for approvals with notifications and Ctrl+J; a terminal dock; first-run onboarding. See `SPEC.md`, `PROGRESS.md`.

```sh
corepack enable && pnpm install
pnpm dev
```

Needs at least one agent CLI installed and signed in, for example Claude Code (`npm install -g @anthropic-ai/claude-code`), Codex (`npm install -g @openai/codex`) or Gemini CLI (`npm install -g @google/gemini-cli`). Without one, the demo agent still works.
