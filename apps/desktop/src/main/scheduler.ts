import type { ScheduledMessage } from "@latis/shared";
import type { WorkspaceStore } from "./store/workspace";

// Send later (SPEC §9.10). Messages wait in the `scheduled` table, so they survive restarts.
// One that was due while Latis was closed goes out once on the next launch, with a note saying so.

const TICK_MS = 15_000;
/** Later than this counts as missed rather than just a slow timer. */
const LATE_MS = 2 * 60_000;

export interface SchedulerDeps {
  store: WorkspaceStore;
  /** Sends now if the chat is idle, otherwise after its turn. */
  deliver(chatId: string, text: string): Promise<unknown>;
  note(chatId: string, text: string): void;
  changed(list: ScheduledMessage[]): void;
  now?(): number;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firing = new Set<string>();

  constructor(private readonly d: SchedulerDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  list(): ScheduledMessage[] {
    return this.d.store.scheduledAll();
  }

  add(input: Omit<ScheduledMessage, "id">): ScheduledMessage {
    const item = this.d.store.addScheduled(input);
    this.d.changed(this.list());
    // Something due within the next tick goes out on time.
    if (input.fireAt - this.now() < TICK_MS) setTimeout(() => void this.tick(), Math.max(0, input.fireAt - this.now()));
    return item;
  }

  cancel(id: string): boolean {
    const ok = this.d.store.removeScheduled(id);
    if (ok) this.d.changed(this.list());
    return ok;
  }

  /** Drops a deleted chat's messages. */
  forgetChat(chatId: string): void {
    for (const m of this.list()) if (m.chatId === chatId) this.d.store.removeScheduled(m.id);
    this.d.changed(this.list());
  }

  async tick(): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const m of this.list()) {
      if (m.fireAt > now || this.firing.has(m.id)) continue;
      this.firing.add(m.id);
      try {
        if (now - m.fireAt > LATE_MS) {
          const when = new Date(m.fireAt).toLocaleString();
          this.d.note(m.chatId, `This message was scheduled for ${when} and is late because Latis wasn't running then.`);
        }
        await this.d.deliver(m.chatId, m.text);
      } catch (err) {
        console.warn("[scheduler] couldn't send a scheduled message", err);
      } finally {
        this.firing.delete(m.id);
      }
      if (m.repeatMs) {
        // Missed repeats collapse into one send; the next one is the first slot after now.
        const skips = Math.floor((now - m.fireAt) / m.repeatMs) + 1;
        this.d.store.rescheduled(m.id, m.fireAt + skips * m.repeatMs);
      } else this.d.store.removeScheduled(m.id);
      changed = true;
    }
    if (changed) this.d.changed(this.list());
  }
}
