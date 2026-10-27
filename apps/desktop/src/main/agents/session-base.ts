import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@lattiz/shared";

type ExitInfo = { code: number | null; signal: string | null };

/** Listener plumbing shared by the protocol-based sessions. */
export abstract class SessionBase {
  readonly id = randomUUID();
  nativeSessionId?: string;
  private listeners = new Set<(e: AgentEvent) => void>();
  private exitListeners = new Set<(info: ExitInfo) => void>();
  private exited = false;

  protected emit(e: AgentEvent): void {
    if (e.type === "session.started" && e.nativeSessionId) this.nativeSessionId = e.nativeSessionId;
    for (const l of this.listeners) l(e);
  }

  protected exit(info: ExitInfo): void {
    if (this.exited) return;
    this.exited = true;
    for (const l of this.exitListeners) l(info);
  }

  onEvent(listener: (e: AgentEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (info: ExitInfo) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}
