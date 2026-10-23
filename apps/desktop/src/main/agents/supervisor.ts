import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  nextStatus,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type AttentionItem,
  type ChatStatus,
  type ChatSummary,
  type PermissionMode,
  type QueuedMessage,
  type RequestResponse,
  type SessionOptions,
  type StoredEvent,
  type Turn,
  type UsageWindow,
  type UserTurn,
} from "@latis/shared";
import type { EventLog } from "../store/event-log";
import type { ChatOptionsPatch, WorkspaceStore } from "../store/workspace";

interface Live {
  session: AgentSession;
  turnId: string | null;
  /** Started with `resume`; cleared once the agent confirms the session. */
  resuming: boolean;
  /** An error item was already raised this turn, so a failed turn end doesn't add a second. */
  erroredThisTurn: boolean;
  /** The agent reported a usage limit this turn. */
  limitedThisTurn: boolean;
  unsubs: (() => void)[];
}

export interface SupervisorSinks {
  event(se: StoredEvent): void;
  status(chatId: string, status: ChatStatus): void;
  updated(chat: ChatSummary): void;
  queue(chatId: string, queue: QueuedMessage[]): void;
  turn(turn: Turn): void;
  /** The full open Inbox after any change. */
  attention(items: AttentionItem[]): void;
  /** A new item worth a notification. */
  raised(item: AttentionItem): void;
  /** Usage windows or a limit the agent reported (§9.12). */
  usage?(agentId: string, patch: { windows?: UsageWindow[]; limited?: { resetsAt: string | null; message: string } | null }): void;
}

/** Checkpoints around turns (§9.4); failures are logged, never block the agent. */
export interface TurnHooks {
  beforeTurn(chatId: string, turnId: string): Promise<void>;
  afterTurn(chatId: string, turnId: string, finalMessage: string | undefined): Promise<void>;
}

export interface SessionExtras {
  /** Per-session options: MCP servers, instructions (§10). */
  sessionOptions?(chat: ChatSummary): Promise<Partial<SessionOptions>>;
  /** What the agent receives for what the user typed (skills, §9.14). The transcript keeps the typed text. */
  expand?(chatId: string, text: string): string;
  /** A turn ended, with the agent's final message (flows, §11). */
  turnEnded?(chatId: string, status: "ok" | "interrupted" | "error", finalMessage: string | undefined): void;
}

const TITLE_MAX = 48;
const DETAIL_MAX = 160;
const REQUEST_KINDS = ["permission", "question", "plan"] as const;

const firstLine = (s: string, max = DETAIL_MAX) => {
  const line = s.trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/**
 * Owns agent sessions (SPEC §5.1). An adapter or agent crash never propagates:
 * the chat moves to `error` and can be restarted. Also owns the steering queue
 * (§9.9) and raises Inbox items (§8.6).
 */
export class SessionSupervisor {
  private live = new Map<string, Live>();
  private statuses = new Map<string, ChatStatus>();
  private queues = new Map<string, QueuedMessage[]>();
  /** Chats with an open permission/question/plan item; the next agent event means it was answered. */
  private openRequests = new Set<string>();
  /** "Send now": the message to send once the interrupted turn has ended. */
  private sendAfterInterrupt = new Map<string, QueuedMessage>();
  /** The latest assistant text per chat, for the "finished" item. */
  private lastMessage = new Map<string, string>();
  private streamed = new Map<string, string>();
  /** Things the agent should know with the next message (e.g. the user reverted its files). */
  private notes = new Map<string, string[]>();

  constructor(
    private readonly store: WorkspaceStore,
    private readonly log: EventLog,
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly sinks: SupervisorSinks,
    private readonly hooks?: TurnHooks,
    private readonly extras: SessionExtras = {},
  ) {}

  /** The latest assistant text this run, for the workspace tools. */
  lastMessageOf(chatId: string): string | undefined {
    return this.lastMessage.get(chatId) ?? this.streamed.get(chatId);
  }

  /** True while a turn runs. */
  busy(chatId: string): boolean {
    return Boolean(this.live.get(chatId)?.turnId) || this.queueOf(chatId).length > 0;
  }

  /** Sends now when the chat is idle, otherwise waits for the running turn to end (send_message mode "queue"). */
  async enqueue(chatId: string, text: string): Promise<"sent" | "queued"> {
    if (!this.live.get(chatId)?.turnId) {
      await this.send(chatId, text);
      return "sent";
    }
    this.setQueue(chatId, [...this.queueOf(chatId), { id: randomUUID(), text, createdAt: Date.now() }]);
    return "queued";
  }

  /** Queues a note that goes to the agent with the user's next message (§9.4 AC2, §9.5 AC3). */
  addNote(chatId: string, text: string) {
    this.notes.set(chatId, [...(this.notes.get(chatId) ?? []), text]);
  }

  async send(chatId: string, text: string, images?: UserTurn["images"]): Promise<Turn> {
    this.resolve(chatId, { kinds: ["finished", "error", "rate_limited"] });
    this.lastMessage.delete(chatId);
    this.streamed.delete(chatId);
    let live: Live;
    try {
      live = await this.ensureSession(chatId);
    } catch (err) {
      // Couldn't start the agent (not installed, signed out, bad cwd…): record it in the chat instead of throwing.
      const turn = this.store.createTurn(chatId, text);
      const message = err instanceof Error ? err.message : String(err);
      this.sinks.event(this.log.append(chatId, turn.id, { type: "error", message, recoverable: false }));
      this.store.endTurn(turn.id, "error");
      this.log.flush();
      this.setStatus(chatId, "error");
      this.raise(chatId, "error", null, message);
      this.extras.turnEnded?.(chatId, "error", undefined);
      return { ...turn, endedAt: Date.now(), status: "error" };
    }
    const turn = this.store.createTurn(chatId, text);
    live.turnId = turn.id;
    live.erroredThisTurn = false;
    live.limitedThisTurn = false;
    this.sinks.turn(turn);
    this.setStatus(chatId, "working");
    await this.hooks?.beforeTurn(chatId, turn.id).catch((err: unknown) => console.warn("[supervisor] checkpoint failed", err));
    const notes = this.notes.get(chatId);
    this.notes.delete(chatId);
    // Notes reach the agent but not the transcript, which shows what the user typed.
    const typed = this.expand(chatId, text);
    const forAgent = notes?.length ? `${notes.map((n) => `[Note from Latis] ${n}`).join("\n")}\n\n${typed}` : typed;
    await live.session.send({ text: forAgent, ...(images?.length && { images }) });
    return turn;
  }

  /**
   * A message typed while a turn runs (§9.9): delivered at the agent's next step when it
   * supports steering, otherwise queued until the turn ends. With no turn running it's a normal send.
   */
  async steer(
    chatId: string,
    text: string,
    images?: UserTurn["images"],
  ): Promise<{ delivered: "steered" | "queued" | "sent"; queue: QueuedMessage[] }> {
    const live = this.live.get(chatId);
    if (!live?.turnId) {
      await this.send(chatId, text, images);
      return { delivered: "sent", queue: this.queueOf(chatId) };
    }
    // Steering carries text only; a message with images waits for the turn to end.
    if (live.session.steer && !images?.length) {
      try {
        await live.session.steer(this.expand(chatId, text));
        this.sinks.event(this.log.append(chatId, live.turnId, { type: "user.steered", text }));
        return { delivered: "steered", queue: this.queueOf(chatId) };
      } catch (err) {
        console.warn("[supervisor] steer failed; queueing instead", err);
      }
    }
    const queue = [...this.queueOf(chatId), { id: randomUUID(), text, createdAt: Date.now(), ...(images?.length && { images }) }];
    this.setQueue(chatId, queue);
    return { delivered: "queued", queue };
  }

  private expand(chatId: string, text: string): string {
    try {
      return this.extras.expand?.(chatId, text) ?? text;
    } catch (err) {
      console.warn("[supervisor] expanding skills failed", err);
      return text;
    }
  }

  queueOf(chatId: string): QueuedMessage[] {
    return this.queues.get(chatId) ?? [];
  }

  editQueued(chatId: string, id: string, text: string): QueuedMessage[] {
    const queue = this.queueOf(chatId).map((q) => (q.id === id ? { ...q, text } : q));
    this.setQueue(chatId, queue);
    return queue;
  }

  removeQueued(chatId: string, id: string): QueuedMessage[] {
    const queue = this.queueOf(chatId).filter((q) => q.id !== id);
    this.setQueue(chatId, queue);
    return queue;
  }

  /** Interrupts the running turn and sends a queued message as soon as it has stopped. */
  async sendNow(chatId: string, id: string): Promise<boolean> {
    const item = this.queueOf(chatId).find((q) => q.id === id);
    if (!item) return false;
    this.removeQueued(chatId, id);
    const live = this.live.get(chatId);
    if (!live?.turnId) {
      await this.send(chatId, item.text, item.images);
      return true;
    }
    this.sendAfterInterrupt.set(chatId, item);
    await live.session.interrupt();
    return true;
  }

  async respond(chatId: string, requestId: string, response: RequestResponse) {
    const live = this.live.get(chatId);
    if (!live) return false;
    await live.session.respond(requestId, response);
    this.resolve(chatId, { refId: requestId });
    this.setStatus(chatId, "working");
    return true;
  }

  async interrupt(chatId: string) {
    const live = this.live.get(chatId);
    if (!live) return false;
    await live.session.interrupt();
    return true;
  }

  async restart(chatId: string) {
    await this.stop(chatId);
    this.resolve(chatId, {});
    this.setStatus(chatId, "idle");
    return true;
  }

  /** Ends the structured session so the conversation can continue elsewhere (open as terminal). */
  async release(chatId: string) {
    await this.stop(chatId);
    this.setStatus(chatId, "idle");
  }

  /**
   * Starts (or restarts, if its process exited) a terminal-only agent's session and
   * returns the PTY its chat card shows.
   */
  async attachTerminal(chatId: string, running: (ptyId: string) => boolean): Promise<string> {
    const existing = this.live.get(chatId);
    if (existing?.session.ptyId && !running(existing.session.ptyId)) await this.stop(chatId);
    const live = await this.ensureSession(chatId);
    if (!live.session.ptyId) throw new Error("This chat's agent doesn't run in a terminal.");
    return live.session.ptyId;
  }

  /** The user has seen the chat: its finished/error items are done. */
  seen(chatId: string) {
    this.resolve(chatId, { kinds: ["finished", "error", "rate_limited"] });
  }

  dismiss(id: string) {
    if (this.store.dismissAttention(id)) this.sinks.attention(this.store.openAttention());
  }

  /** Applies picker changes; live sessions get them immediately where the adapter supports it. */
  async setOptions(chatId: string, patch: ChatOptionsPatch): Promise<ChatSummary> {
    const before = this.store.getChat(chatId);
    if (!before) throw new Error(`no chat ${chatId}`);
    this.store.updateChat(chatId, { ...patch, ...(patch.title !== undefined && { titleLocked: true }) });
    const after = this.store.getChat(chatId)!;
    const live = this.live.get(chatId);
    if (live) {
      try {
        if ((patch.model !== undefined || patch.reasoning !== undefined) && live.session.setModel) {
          await live.session.setModel(after.model ?? "default", after.reasoning ?? undefined);
        }
        if (patch.permissionMode && patch.permissionMode !== before.permissionMode) {
          if (live.session.setPermissionMode) await live.session.setPermissionMode(patch.permissionMode);
          else await this.stop(chatId); // takes effect on the next message
        }
      } catch (err) {
        console.warn("[supervisor] live option change failed; applies to next session", err);
        await this.stop(chatId);
      }
    }
    this.sinks.updated(after);
    return after;
  }

  async disposeAll() {
    await Promise.allSettled([...this.live.keys()].map((id) => this.stop(id)));
    this.log.flush();
  }

  private setQueue(chatId: string, queue: QueuedMessage[]) {
    if (queue.length) this.queues.set(chatId, queue);
    else this.queues.delete(chatId);
    this.sinks.queue(chatId, queue);
  }

  private raise(chatId: string, kind: AttentionItem["kind"], refId: string | null, summary: string, detail?: string) {
    const item = this.store.addAttention({ chatId, kind, refId, summary, ...(detail && { detail }) });
    if ((REQUEST_KINDS as readonly string[]).includes(kind)) this.openRequests.add(chatId);
    this.sinks.attention(this.store.openAttention());
    this.sinks.raised(item);
  }

  private resolve(chatId: string, filter: Parameters<WorkspaceStore["resolveAttention"]>[1]) {
    if (this.store.resolveAttention(chatId, filter) > 0) this.sinks.attention(this.store.openAttention());
  }

  private async stop(chatId: string) {
    const live = this.live.get(chatId);
    if (!live) return;
    this.live.delete(chatId);
    live.unsubs.forEach((u) => u());
    if (live.turnId) this.store.endTurn(live.turnId, "interrupted");
    await live.session.dispose().catch((err: unknown) => console.warn("[supervisor] dispose failed", err));
  }

  private async ensureSession(chatId: string): Promise<Live> {
    const existing = this.live.get(chatId);
    if (existing) return existing;
    const chat = this.store.getChat(chatId);
    if (!chat) throw new Error(`no chat ${chatId}`);
    const adapter = this.adapters.get(chat.agentId);
    if (!adapter) throw new Error(`Agent "${chat.agentId}" isn't available.`);
    mkdirSync(chat.cwd, { recursive: true });
    const opts: SessionOptions = {
      cwd: chat.cwd,
      chatId,
      permissionMode: chat.permissionMode as PermissionMode,
      alwaysAsk: [],
      ...(chat.model && { model: chat.model }),
      ...(chat.reasoning && { reasoning: chat.reasoning }),
      ...(await this.extras.sessionOptions?.(chat)),
    };
    const native = this.store.nativeSessionId(chatId);
    const resuming = Boolean(native && adapter.resumeSession);
    const session = resuming ? await adapter.resumeSession!(native!, opts) : await adapter.startSession(opts);
    const live: Live = { session, turnId: null, resuming, erroredThisTurn: false, limitedThisTurn: false, unsubs: [] };
    live.unsubs.push(
      session.onEvent((e) => this.onEvent(chatId, live, e)),
      session.onExit(({ code, signal }) => this.onCrash(chatId, live, code, signal)),
    );
    this.live.set(chatId, live);
    return live;
  }

  private onEvent(chatId: string, live: Live, e: AgentEvent) {
    try {
      const agentId = this.store.getChat(chatId)?.agentId;
      // The meter isn't part of the conversation, so it doesn't go into the transcript.
      if (e.type === "usage.window") {
        if (agentId) this.sinks.usage?.(agentId, { windows: e.windows });
        return;
      }
      if (e.type === "rate_limited") {
        live.limitedThisTurn = true;
        if (agentId) this.sinks.usage?.(agentId, { limited: { resetsAt: e.resetsAt ?? null, message: e.message } });
      }
      if (e.type === "turn.completed" && e.status === "ok" && !live.limitedThisTurn && agentId)
        this.sinks.usage?.(agentId, { limited: null });
      if (e.type === "session.started" && e.nativeSessionId) {
        live.resuming = false;
        if (this.store.nativeSessionId(chatId) !== e.nativeSessionId) {
          this.store.updateChat(chatId, { nativeSessionId: e.nativeSessionId });
          this.sinks.updated(this.store.getChat(chatId)!);
        }
      }
      if (e.type === "turn.completed" && e.status === "error" && live.resuming) {
        // The stored conversation couldn't be resumed (deleted or from another machine). Start fresh next time.
        live.resuming = false;
        this.store.updateChat(chatId, { nativeSessionId: null });
        this.sinks.event(
          this.log.append(chatId, live.turnId, {
            type: "error",
            message: "Couldn't resume the previous conversation. Your next message starts a new one.",
            recoverable: true,
          }),
        );
        void this.stop(chatId);
      }
      // The agent blocks while a request is open, so its next event means the request was answered elsewhere.
      const isRequest =
        ["permission.requested", "question.asked", "plan.proposed", "usage"].includes(e.type) ||
        (e.type === "agent.status" && e.status === "needs-you");
      if (this.openRequests.has(chatId) && !isRequest) {
        this.openRequests.delete(chatId);
        this.resolve(chatId, { kinds: [...REQUEST_KINDS] });
      }
      this.sinks.event(this.log.append(chatId, live.turnId, e));
      this.setStatus(chatId, nextStatus(this.statuses.get(chatId) ?? "idle", e));
      // Agents that only stream (no message.completed) still get a summary from their streamed text.
      if (e.type === "message.delta") this.streamed.set(chatId, (this.streamed.get(chatId) ?? "") + e.text);
      if (e.type === "message.completed" || e.type === "tool.started") {
        const text = e.type === "message.completed" ? e.text : this.streamed.get(chatId);
        if (text?.trim()) this.lastMessage.set(chatId, text);
        this.streamed.delete(chatId);
      }
      if (e.type === "turn.completed" && this.streamed.get(chatId)?.trim()) {
        this.lastMessage.set(chatId, this.streamed.get(chatId)!);
        this.streamed.delete(chatId);
      }
      this.attentionFor(chatId, live, e);
      if (e.type === "turn.completed" && live.turnId) {
        this.store.endTurn(live.turnId, e.status);
        const turnId = live.turnId;
        void this.hooks
          ?.afterTurn(chatId, turnId, this.lastMessage.get(chatId))
          .catch((err: unknown) => console.warn("[supervisor] checkpoint failed", err));
        if (e.status === "ok") this.autoTitle(chatId);
        live.turnId = null;
        this.afterTurn(chatId, e.status);
        this.extras.turnEnded?.(chatId, e.status, this.lastMessage.get(chatId));
      }
    } catch (err) {
      console.error("[supervisor] event handling failed", err);
    }
  }

  private attentionFor(chatId: string, live: Live, e: AgentEvent) {
    switch (e.type) {
      case "permission.requested":
        this.raise(chatId, "permission", e.id, e.summary, e.command ?? e.paths?.join(", "));
        break;
      case "question.asked":
        this.raise(chatId, "question", e.id, e.questions?.[0]?.question ?? e.question);
        break;
      case "plan.proposed":
        this.raise(chatId, "plan", e.id, "Plan ready for review", firstLine(e.markdown.replace(/^#+\s*/, "")));
        break;
      case "rate_limited":
        this.raise(chatId, "rate_limited", null, e.message);
        break;
      case "agent.status": {
        // Terminal-only agents: answered in the terminal itself, so these items carry no request id.
        const title = this.store.getChat(chatId)?.title ?? "Chat";
        // A bare prompt ("> ", "$") says nothing; keep only real lines.
        const detail = e.detail && /[A-Za-z0-9]{2}/.test(e.detail) ? e.detail : undefined;
        if (e.status === "needs-you") this.raise(chatId, "permission", null, `${title} is waiting for you`, detail);
        else if (e.status === "idle") this.raise(chatId, "finished", null, `${title} finished`, detail);
        else this.resolve(chatId, { kinds: ["finished"] });
        break;
      }
      case "error":
        if (!e.recoverable) {
          live.erroredThisTurn = true;
          this.raise(chatId, "error", null, e.message);
        }
        break;
      case "turn.completed":
        this.resolve(chatId, { kinds: [...REQUEST_KINDS] });
        this.openRequests.delete(chatId);
        if (e.status === "error" && !live.erroredThisTurn) this.raise(chatId, "error", null, "The turn ended with an error.");
        // Not "finished" yet if a queued message is about to go out.
        if (e.status === "ok" && !this.queueOf(chatId).length && !this.sendAfterInterrupt.has(chatId)) {
          const title = this.store.getChat(chatId)?.title ?? "Chat";
          const last = this.lastMessage.get(chatId);
          this.raise(chatId, "finished", null, `${title} finished`, last ? firstLine(last) : undefined);
        }
        break;
      default:
        break;
    }
  }

  /** Sends what's waiting once a turn is over: "Send now" first, then the queue (only after a clean finish). */
  private afterTurn(chatId: string, status: "ok" | "interrupted" | "error") {
    const now = this.sendAfterInterrupt.get(chatId);
    let next: QueuedMessage | undefined;
    if (now !== undefined) {
      this.sendAfterInterrupt.delete(chatId);
      next = now;
    } else if (status === "ok") {
      const [head, ...rest] = this.queueOf(chatId);
      if (head) {
        this.setQueue(chatId, rest);
        next = head;
      }
    }
    if (next !== undefined) {
      const msg = next;
      setTimeout(
        () => void this.send(chatId, msg.text, msg.images).catch((err: unknown) => console.error("[supervisor] queued send failed", err)),
        0,
      );
    }
  }

  /** Titles a chat from its first message until the user renames it (§8.5). */
  private autoTitle(chatId: string) {
    if (this.store.isTitleLocked(chatId)) return;
    const first = this.store.transcript(chatId).turns[0];
    if (!first) return;
    const title = firstLine(first.userText, TITLE_MAX);
    const chat = this.store.getChat(chatId);
    if (!title || chat?.title === title) return;
    this.store.updateChat(chatId, { title });
    this.sinks.updated(this.store.getChat(chatId)!);
  }

  private onCrash(chatId: string, live: Live, code: number | null, signal: string | null) {
    if (this.live.get(chatId) !== live) return;
    this.live.delete(chatId);
    live.unsubs.forEach((u) => u());
    const why = signal ? `signal ${signal}` : `code ${code}`;
    const message = `Agent process exited (${why}).`;
    this.sinks.event(this.log.append(chatId, live.turnId, { type: "error", message, recoverable: false }));
    if (live.turnId) this.store.endTurn(live.turnId, "error");
    this.log.flush();
    this.setStatus(chatId, "error");
    this.resolve(chatId, { kinds: [...REQUEST_KINDS] });
    this.raise(chatId, "error", null, message);
    if (live.turnId) this.extras.turnEnded?.(chatId, "error", undefined);
  }

  private setStatus(chatId: string, status: ChatStatus) {
    if (this.statuses.get(chatId) === status) return;
    this.statuses.set(chatId, status);
    this.store.updateChat(chatId, { status });
    this.sinks.status(chatId, status);
  }
}
