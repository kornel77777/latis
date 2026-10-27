import { buildTranscript, type LatticeNode } from "@lattiz/shared";
import { useWorkspace } from "../stores/workspace";
import { paneIds, place, type Zone } from "./tree";

// Working with several agents at once in the lattice: stack a new agent next to a pane, send one
// message to many panes, and pass one agent's reply to another.

/** Where a chat that is being created should land once it appears in the lattice. */
export const pendingPlacement = new Map<string, { target: string; zone: Exclude<Zone, "center"> }>();

const ws = () => useWorkspace.getState();
type State = ReturnType<typeof useWorkspace.getState>;

/** The project new chats from the lattice go into: the filter, else the focused pane's, else the only one. */
export function targetProject(s: State = ws()): string | null {
  if (s.lattice.projectId) return s.lattice.projectId;
  const focused = s.latticeFocus ? s.chats[s.latticeFocus]?.summary.projectId : null;
  if (focused) return focused;
  const ids = Object.keys(s.projects);
  return ids.length === 1 ? ids[0]! : null;
}

/** Whether `agentId` can start a chat in `projectId` (the demo agent works without a project). */
export function canStart(agentId: string, projectId: string | null): boolean {
  return agentId === "fake" || projectId !== null;
}

/** Starts a chat with `agentId`; with `near`, it tiles beside that pane on the given side. */
export async function stackAgent(
  agentId: string,
  projectId: string | null,
  near?: { target: string; zone: Exclude<Zone, "center"> },
): Promise<string | null> {
  const s = ws();
  const project = agentId === "fake" && !s.demoInProjects ? null : projectId;
  const id = await s.createChat({ agentId, projectId: project });
  if (id && near) {
    pendingPlacement.set(id, near);
    // The lattice may already have tiled it before this resolved.
    const root = ws().lattice.root;
    if (root) ws().setLattice({ root: applyPending(root) });
  }
  return id;
}

/** Applies any pending placements whose chats are already in the tree. */
export function applyPending(root: LatticeNode): LatticeNode {
  let next = root;
  for (const [id, at] of pendingPlacement) {
    const ids = paneIds(next);
    if (!ids.includes(id)) continue;
    pendingPlacement.delete(id);
    if (ids.includes(at.target)) next = place(next, id, at.target, at.zone);
  }
  return next;
}

/** Chats that can take a typed message (terminal agents can't). */
export function canMessage(chatId: string): boolean {
  const s = ws();
  const chat = s.chats[chatId];
  if (!chat) return false;
  return s.agents.find((a) => a.id === chat.summary.agentId)?.kind !== "terminal";
}

/** Sends `text` to a chat: steers it if it's mid-turn, otherwise starts a turn. */
export async function deliver(chatId: string, text: string): Promise<void> {
  const s = ws();
  const status = s.chats[chatId]?.summary.status;
  if (status === "working" || status === "needs-you") await s.steer(chatId, text);
  else await s.send(chatId, text);
}

/** Sends the same message to several chats at once. */
export async function broadcast(chatIds: string[], text: string): Promise<void> {
  await Promise.all(chatIds.filter(canMessage).map((id) => deliver(id, text)));
}

/** The text of a chat's latest agent reply, or null if it hasn't said anything yet. */
export async function lastReply(chatId: string): Promise<string | null> {
  let chat = ws().chats[chatId];
  if (chat && !chat.loaded) {
    await ws().loadTranscript(chatId);
    chat = ws().chats[chatId];
  }
  if (!chat) return null;
  const items = buildTranscript(chat.turns, chat.events);
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "assistant" && it.text.trim()) return it.text.trim();
  }
  return null;
}

function label(chatId: string): string {
  const s = ws();
  const c = s.chats[chatId]?.summary;
  if (!c) return "another chat";
  const agent = s.agents.find((a) => a.id === c.agentId)?.displayName ?? c.agentId;
  return `${agent} ("${c.title}")`;
}

/** How a passed reply reads to the receiving agent. */
export function quoteReply(fromChatId: string, reply: string): string {
  return `From ${label(fromChatId)}, working alongside you:\n\n<reply>\n${reply}\n</reply>\n\n`;
}

/** Puts `from`'s latest reply into `to`'s composer (to add an instruction before sending) and focuses it. */
export async function passReply(from: string, to: string): Promise<boolean> {
  const reply = await lastReply(from);
  if (!reply) {
    ws().toast("That chat hasn't replied yet.");
    return false;
  }
  const s = ws();
  const draft = s.drafts[to];
  const text = (draft ? `${draft.trimEnd()}\n\n` : "") + quoteReply(from, reply);
  const nodeId = s.chats[to]?.summary.nodeId;
  useWorkspace.setState((st) => ({ drafts: { ...st.drafts, [to]: text }, focusComposer: to, latticeFocus: to }));
  if (nodeId) s.focusNode(nodeId);
  return true;
}

/** Sends `from`'s latest reply to every other pane and asks each for a review. */
export async function askOthersToReview(from: string, others: string[]): Promise<void> {
  const reply = await lastReply(from);
  if (!reply) {
    ws().toast("That chat hasn't replied yet.");
    return;
  }
  const targets = others.filter((id) => id !== from && canMessage(id));
  if (!targets.length) {
    ws().toast("There's no other chat in the lattice to ask.");
    return;
  }
  const text = `${quoteReply(from, reply)}Review this. Say where you agree, what's wrong or missing, and what you'd do instead. Be brief.`;
  await broadcast(targets, text);
  ws().toast(`Asked ${targets.length} ${targets.length === 1 ? "chat" : "chats"} to review.`);
}
