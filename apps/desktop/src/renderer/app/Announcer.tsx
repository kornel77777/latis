import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../stores/workspace";

// Screen-reader announcements for the attention system (§8.12): state changes that need the
// user are spoken, not only shown as colours and badges.

const NEEDS_YOU = new Set(["permission", "question", "plan", "rate_limited", "error"]);

export function Announcer() {
  const items = useWorkspace((s) => s.attention);
  const ready = useWorkspace((s) => s.ready);
  const seen = useRef<Set<string> | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    // What's already in the Inbox at launch isn't news.
    if (!ready) return;
    if (!seen.current) {
      seen.current = new Set(items.map((i) => i.id));
      return;
    }
    const fresh = items.filter((i) => !seen.current!.has(i.id));
    for (const i of items) seen.current.add(i.id);
    const urgent = fresh.find((i) => NEEDS_YOU.has(i.kind)) ?? fresh[0];
    if (!urgent) return;
    const title = useWorkspace.getState().chats[urgent.chatId]?.summary.title ?? "A chat";
    const text = urgent.kind === "finished" ? urgent.summary : `${title} needs you: ${urgent.summary}`;
    // Set on the next frame so a repeat of the same text is still read out.
    requestAnimationFrame(() => setMessage(text));
  }, [items, ready]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="announcer">
      {message}
    </div>
  );
}
