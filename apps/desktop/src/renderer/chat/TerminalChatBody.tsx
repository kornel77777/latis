import { useCallback, useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { PtyInfo, TranscriptItem } from "@latis/shared";
import { Button } from "@latis/ui";
import { eventContract } from "@latis/shared";
import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";
import { TerminalView } from "../terminal/TerminalView";
import { PermissionBlock } from "./items";

/**
 * A terminal agent's chat card. Claude Code in a terminal also reports approvals to Latis (hooks); the ones only
 * Latis can answer, like the always-ask list, show as a banner over the terminal.
 */
export function TerminalChatBody({
  chatId,
  requests = [],
}: {
  chatId: string;
  requests?: Extract<TranscriptItem, { kind: "permission" }>[];
}) {
  const respond = useWorkspace((s) => s.respond);
  const [pty, setPty] = useState<PtyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attach = useCallback(() => {
    latis
      .invoke("chat:attachTerminal", { chatId })
      .then((info) => {
        setError(null);
        setPty(info);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [chatId]);

  useEffect(attach, [attach]);
  useEffect(
    () =>
      latis.on("pty:exit", (raw) => {
        const parsed = eventContract["pty:exit"].safeParse(raw);
        if (parsed.success) setPty((p) => (p && p.id === parsed.data.id ? { ...p, running: false } : p));
      }),
    [],
  );

  return (
    <div className="nowheel nodrag relative min-h-0 flex-1 bg-bg-0 p-1.5" data-testid="terminal-chat">
      {pty && <TerminalView ptyId={pty.id} className="h-full w-full" />}
      {requests.length > 0 && (
        <div className="absolute inset-x-3 top-3 z-10 flex flex-col gap-1.5" data-testid="terminal-requests">
          {requests.map((item) => (
            <div key={item.key} className="rounded-control bg-surface shadow-lg">
              <PermissionBlock item={item} respond={(id, r) => void respond(chatId, id, r)} />
            </div>
          ))}
        </div>
      )}
      {(error || (pty && !pty.running)) && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-control border border-line bg-surface px-3 py-2 text-[12.5px]">
          <span className="min-w-0 flex-1 truncate text-text-2">{error ?? "The agent exited."}</span>
          <Button size="sm" variant="primary" onClick={attach} data-testid="terminal-start">
            <Play size={12} /> Start again
          </Button>
        </div>
      )}
    </div>
  );
}
