import { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";

/** How close to the bottom (px) still counts as "at the bottom". */
const NEAR_BOTTOM = 24;
const UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

/**
 * Keeps a transcript pinned to the bottom while the agent streams.
 *
 * Virtuoso's `followOutput` only fires when items are appended. A streaming reply grows the last
 * item in place, so on its own the view stops following after the first line. Here the list is
 * "stuck" until the user scrolls up (wheel, keys, or dragging the scrollbar), and while stuck any
 * growth of the list or shrink of the viewport (a lattice tile being resized) re-pins it. Scrolling
 * back to the bottom sticks it again.
 */
export function useFollowOutput(list: RefObject<VirtuosoHandle | null>) {
  const stuck = useRef(true);
  const scroller = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    else list.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [list]);

  const scrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    cleanup.current?.();
    cleanup.current = null;
    const el = ref instanceof HTMLElement ? ref : null;
    scroller.current = el;
    if (!el) return;

    let lastTop = el.scrollTop;
    let pointerDown = false;
    const unstick = () => {
      stuck.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) unstick();
    };
    const onKey = (e: KeyboardEvent) => {
      if (UP_KEYS.has(e.key)) unstick();
    };
    const onPointerDown = () => {
      pointerDown = true;
    };
    const onPointerUp = () => {
      pointerDown = false;
    };
    const onScroll = () => {
      const top = el.scrollTop;
      // Dragging the scrollbar or a touch drag upwards.
      if (pointerDown && top < lastTop - 1) unstick();
      if (el.scrollHeight - top - el.clientHeight <= NEAR_BOTTOM) stuck.current = true;
      lastTop = top;
    };
    const resize = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });

    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("keydown", onKey);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("touchstart", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchend", onPointerUp);
    el.addEventListener("scroll", onScroll, { passive: true });
    resize.observe(el);
    cleanup.current = () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("touchstart", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchend", onPointerUp);
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  return useMemo(
    () => ({
      scrollerRef,
      toBottom,
      /** Re-pin, e.g. when the user sends a message. */
      stick: () => {
        stuck.current = true;
        toBottom();
      },
      followOutput: () => (stuck.current ? ("auto" as const) : false),
      onHeightChange: () => {
        if (stuck.current) toBottom();
      },
    }),
    [scrollerRef, toBottom],
  );
}
