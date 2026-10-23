import { app, Notification, type BrowserWindow } from "electron";
import type { AttentionItem, Prefs } from "@latis/shared";

// OS notifications and the dock/taskbar badge for the attention system (SPEC §8.6).

const NEEDS_YOU = new Set<AttentionItem["kind"]>(["permission", "question", "plan", "rate_limited"]);

export interface NotifierDeps {
  window: () => BrowserWindow | null;
  prefs: () => Prefs;
  chatTitle: (chatId: string) => string;
  /** Chats currently on screen in the renderer. */
  visible: () => Set<string>;
  focusChat: (chatId: string) => void;
  respond: (item: AttentionItem, allow: boolean) => void;
}

export class Notifier {
  /** Kept referenced so macOS delivers their click/action events. */
  private live = new Map<string, Notification>();

  constructor(private readonly deps: NotifierDeps) {}

  badge(items: AttentionItem[]): void {
    const count = items.filter((i) => NEEDS_YOU.has(i.kind)).length;
    // macOS dock and Linux Unity launchers; Windows has no numeric badge API in Electron (DECISIONS.md).
    app.setBadgeCount(count);
    for (const [id, n] of this.live) {
      if (!items.some((i) => i.id === id)) {
        n.close();
        this.live.delete(id);
      }
    }
  }

  raised(item: AttentionItem): void {
    const prefs = this.deps.prefs();
    const needsYou = NEEDS_YOU.has(item.kind);
    if (needsYou ? !prefs.notifyNeedsYou : item.kind === "finished" ? !prefs.notifyFinished : !prefs.notifyNeedsYou) return;
    const win = this.deps.window();
    // Suppressed when the window is focused and the chat is on screen (§8.6).
    if (win?.isFocused() && this.deps.visible().has(item.chatId)) return;
    if (!Notification.isSupported()) return;
    const actionable = item.kind === "permission" && item.refId !== null && process.platform === "darwin";
    const n = new Notification({
      title: item.kind === "finished" ? item.summary : `${this.deps.chatTitle(item.chatId)}: ${item.summary}`,
      body: item.detail ?? (needsYou ? "Needs your answer" : ""),
      silent: !needsYou,
      ...(actionable && {
        actions: [
          { type: "button" as const, text: "Allow" },
          { type: "button" as const, text: "Deny" },
        ],
      }),
    });
    n.on("click", () => {
      this.live.delete(item.id);
      this.deps.focusChat(item.chatId);
    });
    n.on("action", (_e, index) => {
      this.live.delete(item.id);
      this.deps.respond(item, index === 0);
    });
    n.on("close", () => this.live.delete(item.id));
    this.live.set(item.id, n);
    n.show();
  }
}
