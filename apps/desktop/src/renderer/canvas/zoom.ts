import { useStore } from "@xyflow/react";

// Semantic zoom (§8.4). Nodes subscribe to the bucket, not the zoom, so they
// re-render only when crossing a threshold, not on every zoom step.

export type ZoomLevel = "full" | "condensed" | "tile";

export const levelOf = (zoom: number): ZoomLevel => (zoom >= 0.7 ? "full" : zoom >= 0.45 ? "condensed" : "tile");

export function useZoomLevel(): ZoomLevel {
  return useStore((s) => levelOf(s.transform[2]));
}
