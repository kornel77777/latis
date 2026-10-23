import type { AgentEvent, StoredEvent } from "@latis/shared";
import type { WorkspaceStore } from "./workspace";

/**
 * Append-only event log (SPEC §7.2): seqs are assigned in memory on append and
 * rows are written in batches every 250 ms, plus immediately on turn end.
 */
export class EventLog {
  private pending: StoredEvent[] = [];
  private seqs = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly intervalMs = 250,
  ) {}

  append(chatId: string, turnId: string | null, event: AgentEvent): StoredEvent {
    const seq = (this.seqs.get(chatId) ?? this.store.maxEventSeq(chatId)) + 1;
    this.seqs.set(chatId, seq);
    const se: StoredEvent = { chatId, seq, ts: Date.now(), turnId, event };
    this.pending.push(se);
    if (event.type === "turn.completed") this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
    return se;
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    try {
      this.store.insertEvents(batch);
    } catch (err) {
      // Keep the events in memory and retry on the next flush; never drop them.
      console.error("[event-log] write failed, will retry", err);
      this.pending = batch.concat(this.pending);
      this.timer = setTimeout(() => this.flush(), this.intervalMs * 4);
    }
  }
}
