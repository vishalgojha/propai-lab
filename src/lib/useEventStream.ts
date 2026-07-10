"use client";

import { useEffect, useRef, useCallback } from "react";

type EventCallback = (event: { type: string; data: any; timestamp: string }) => void;

export function useEventStream(handlers: Record<string, EventCallback>) {
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    eventSourceRef.current = es;

    const handlerMap = new Map<string, EventCallback>();
    for (const [eventType, cb] of Object.entries(handlers)) {
      handlerMap.set(eventType, cb);
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data);
          cb(parsed);
        } catch { /* ignore parse errors */ }
      });
    }

    es.onerror = () => {
      // Reconnect handled automatically by EventSource
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);
}
