import { useEffect, useState } from "react";
import { perfCounters } from "../stores/workspace";

// Hidden perf overlay (§14), Ctrl+Alt+P: fps, worst frame, event rate and JS heap.

interface Sample {
  fps: number;
  worst: number;
  eventsPerSec: number;
  heapMb: number | null;
}

export function PerfOverlay() {
  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState<Sample | null>(null);

  useEffect(() => {
    // The perf.toggle command (Ctrl+Alt+P by default).
    const onToggle = () => setOpen((v) => !v);
    window.addEventListener("lattiz-perf-toggle", onToggle);
    return () => window.removeEventListener("lattiz-perf-toggle", onToggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let worst = 0;
    let windowStart = last;
    let events = perfCounters.events;
    const tick = (t: number) => {
      frames++;
      worst = Math.max(worst, t - last);
      last = t;
      if (t - windowStart >= 1000) {
        const secs = (t - windowStart) / 1000;
        const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
        setSample({
          fps: Math.round(frames / secs),
          worst: Math.round(worst),
          eventsPerSec: Math.round((perfCounters.events - events) / secs),
          heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
        });
        frames = 0;
        worst = 0;
        windowStart = t;
        events = perfCounters.events;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="pointer-events-none fixed right-3 top-12 z-50 rounded-control border border-line bg-surface-glass px-3 py-2 font-mono text-[11px] leading-5 text-text-1 backdrop-blur"
      data-testid="perf-overlay"
      aria-hidden
    >
      <div>{sample ? `${sample.fps} fps` : "…"}</div>
      <div className={sample && sample.worst > 32 ? "text-state-error" : "text-text-2"}>worst {sample?.worst ?? "–"} ms</div>
      <div className="text-text-2">{sample?.eventsPerSec ?? 0} events/s</div>
      {sample?.heapMb !== null && <div className="text-text-2">heap {sample?.heapMb} MB</div>}
    </div>
  );
}
