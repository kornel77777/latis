import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Account, AccountsState } from "@latis/shared";
import type { WorkspaceStore } from "./store/workspace";

// Multiple accounts per provider (SPEC §9.12 AC3). An extra account is a separate home folder
// under <dataDir>/accounts; the agent's CLI keeps that account's sign-in there. Latis only points
// the CLI at the folder through the CLI's own env var and never reads what's inside (§6.5).

/** Each CLI's own variable for where it keeps its config and sign-in. */
export const HOME_ENV: Record<string, string> = {
  "claude-code": "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  gemini: "GEMINI_CLI_HOME",
};

export class Accounts {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly dataDir: string,
  ) {}

  state(): AccountsState {
    return {
      accounts: this.store.getSetting<Account[]>("accounts") ?? [],
      active: this.store.getSetting<Record<string, string | null>>("activeAccounts") ?? {},
    };
  }

  supports(agentId: string): boolean {
    return agentId in HOME_ENV;
  }

  add(agentId: string, label: string): Account {
    if (!this.supports(agentId)) throw new Error("Latis can't keep separate accounts for this agent.");
    const id = randomUUID().slice(0, 8);
    const home = join(this.dataDir, "accounts", agentId, id);
    mkdirSync(home, { recursive: true });
    const account: Account = { id, agentId, label: label.trim(), home };
    this.store.setSetting("accounts", [...this.state().accounts, account]);
    return account;
  }

  get(id: string): Account | undefined {
    return this.state().accounts.find((a) => a.id === id);
  }

  /** Forgets an account. Its folder (and the sign-in inside) stays on disk. */
  remove(id: string): void {
    const s = this.state();
    this.store.setSetting(
      "accounts",
      s.accounts.filter((a) => a.id !== id),
    );
    this.store.setSetting("activeAccounts", Object.fromEntries(Object.entries(s.active).filter(([, v]) => v !== id)));
  }

  setActive(agentId: string, accountId: string | null): void {
    if (accountId && this.get(accountId)?.agentId !== agentId) throw new Error("That account belongs to another agent.");
    this.store.setSetting("activeAccounts", { ...this.state().active, [agentId]: accountId });
  }

  /** Env for the agent's active account; empty for the default one (the CLI's usual home). */
  env(agentId: string): Record<string, string> {
    const id = this.state().active[agentId];
    const acc = id ? this.get(id) : undefined;
    return acc && HOME_ENV[agentId] ? { [HOME_ENV[agentId]!]: acc.home } : {};
  }
}
