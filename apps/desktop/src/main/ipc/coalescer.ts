import { coalesceEvents, type StoredEvent } from "@lattiz/shared";

/** Buffers agent events and delivers them per chat every `intervalMs` (SPEC §5.2: 16 ms). */
export class EventCoalescer {
  private buffer: StoredEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliver: (chatId: string, events: StoredEvent[]) => void,
    private readonly intervalMs = 16,
  ) {}

  push(se: StoredEvent): void {
    this.buffer.push(se);
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    this.timer = null;
    const byChat = new Map<string, StoredEvent[]>();
    for (const se of this.buffer) {
      const list = byChat.get(se.chatId) ?? [];
      list.push(se);
      byChat.set(se.chatId, list);
    }
    this.buffer = [];
    for (const [chatId, list] of byChat) this.deliver(chatId, coalesceEvents(list));
  }
}
