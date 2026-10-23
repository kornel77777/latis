import { useEffect, useState } from "react";
import { AppWindow } from "lucide-react";
import { Dialog } from "@latis/ui";
import { latis } from "../api";
import { useWorkspace } from "../stores/workspace";

// The starter card library (§12.3): bundled, offline mini-apps to put on the canvas.

type Starter = { id: string; title: string; description: string };

export function CardLibrary() {
  const at = useWorkspace((s) => s.cardLibraryAt);
  const [list, setList] = useState<Starter[]>([]);
  useEffect(() => {
    if (at && !list.length) void latis.invoke("card:library").then(setList);
  }, [at, list.length]);
  const close = () => useWorkspace.setState({ cardLibraryAt: null });
  const pick = async (starter: string) => {
    const ws = useWorkspace.getState();
    try {
      const node = await latis.invoke("card:create", { canvasId: ws.canvasId, starter, x: Math.round(at!.x), y: Math.round(at!.y) });
      ws.addNode(node);
    } catch (err) {
      ws.toast(err instanceof Error ? err.message : String(err));
    }
    close();
  };
  return (
    <Dialog
      open={Boolean(at)}
      onOpenChange={(o) => !o && close()}
      title="New card"
      description="Small apps that live on the canvas. Or ask the Conductor to make one for you."
      width={560}
    >
      <div className="grid grid-cols-2 gap-2" data-testid="card-library">
        {list.map((s) => (
          <button
            key={s.id}
            onClick={() => void pick(s.id)}
            className="flex items-start gap-2.5 rounded-panel border border-line p-3 text-left hover:border-line-strong hover:bg-surface-2"
          >
            <AppWindow size={16} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="block text-[13px] font-medium text-text-1">{s.title}</span>
              <span className="block text-[12px] text-text-3">{s.description}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
