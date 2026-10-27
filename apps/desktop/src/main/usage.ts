import type { UsageState, UsageWindow } from "@lattiz/shared";
import type { WorkspaceStore } from "./store/workspace";

// Usage meter (SPEC §9.12): what each agent last reported about its account's usage windows and
// limits. Kept in settings so the status bar has numbers after a restart; never estimated.

type Entry = UsageState[string];

export class UsageMeter {
  private state: UsageState;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly changed: (state: UsageState) => void,
  ) {
    this.state = store.getSetting<UsageState>("usage") ?? {};
  }

  get(): UsageState {
    return this.state;
  }

  /** When this agent's limit resets, if it's limited and said when. */
  resetsAt(agentId: string): string | null {
    return this.state[agentId]?.limited?.resetsAt ?? null;
  }

  update(agentId: string, patch: { windows?: UsageWindow[]; limited?: Entry["limited"] }): void {
    const prev: Entry = this.state[agentId] ?? { windows: [], limited: null, updatedAt: 0 };
    // A reset time in the past means the limit is over.
    const limited = patch.limited !== undefined ? patch.limited : prev.limited;
    const next: Entry = {
      windows: patch.windows ?? prev.windows,
      limited: limited?.resetsAt && Date.parse(limited.resetsAt) < Date.now() ? null : limited,
      updatedAt: Date.now(),
    };
    if (JSON.stringify({ ...next, updatedAt: 0 }) === JSON.stringify({ ...prev, updatedAt: 0 })) return;
    this.state = { ...this.state, [agentId]: next };
    this.store.setSetting("usage", this.state);
    this.changed(this.state);
  }
}
