import { X } from "lucide-react";
import { useWorkspace } from "../stores/workspace";

export function Toasts() {
  const toasts = useWorkspace((s) => s.toasts);
  const dismiss = useWorkspace((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-10 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          data-testid="toast"
          className="pointer-events-auto flex max-w-lg items-center gap-3 rounded-control border border-line-strong bg-surface px-3 py-2 text-[13px] text-text-1 shadow-lift"
        >
          <span>{t.message}</span>
          {t.action && (
            <button className="font-medium text-accent" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <button aria-label="Dismiss" className="text-text-3 hover:text-text-1" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
