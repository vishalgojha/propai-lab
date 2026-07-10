"use client";

import { useEffect, useRef, useCallback } from "react";

export function useInfiniteScroll(
  callback: () => void,
  options: { threshold?: number; enabled?: boolean } = {}
) {
  const { threshold = 200, enabled = true } = options;
  const sentinelRef = useRef<HTMLDivElement>(null);

  const handleIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      if (!enabled) return;
      const entry = entries[0];
      if (entry?.isIntersecting) {
        callback();
      }
    },
    [callback, enabled]
  );

  useEffect(() => {
    if (!enabled) return;
    const el = sentinelRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(handleIntersect, {
      rootMargin: `${threshold}px`,
    });
    observer.observe(el);

    return () => observer.disconnect();
  }, [enabled, handleIntersect, threshold]);

  return { sentinelRef };
}
