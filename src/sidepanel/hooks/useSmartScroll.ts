// Bottom-following scroll that respects the user. While output streams in, the
// view sticks to the bottom ONLY if the user is already there; the moment they
// scroll up to read, following stops and new output just accumulates (signalled
// via hasNew so the UI can show a jump-to-bottom affordance).

import { useCallback, useEffect, useRef, useState } from "react";

const BOTTOM_THRESHOLD_PX = 90;

export function useSmartScroll(deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [hasNew, setHasNew] = useState(false);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    followRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setHasNew(false);
  }, []);

  // New content arrived.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (followRef.current) {
      el.scrollTop = el.scrollHeight;
      setHasNew(false);
    } else {
      setHasNew(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // The viewport itself changes height when the navigation opens or retracts
  // and when the composer grows. A reader following the bottom stays there; a
  // reader scrolled up keeps the same text at the top of the view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Resume following and glide to the bottom (jump button / on submit). */
  const scrollToBottom = useCallback((smooth = true) => {
    const el = containerRef.current;
    if (!el) return;
    followRef.current = true;
    setAtBottom(true);
    setHasNew(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  return { containerRef, onScroll, atBottom, hasNew, scrollToBottom };
}
