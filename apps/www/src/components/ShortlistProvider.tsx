"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ListingCardViewModel } from "@/lib/listing-card";

export type ShortlistItem = {
  id: number;
  title: string;
  locality: string | null;
  priceLabel: string;
  href: string | null;
};

type ShortlistContextValue = {
  items: ShortlistItem[];
  has: (id: number) => boolean;
  toggle: (item: ShortlistItem) => void;
  clear: () => void;
  count: number;
};

const ShortlistContext = createContext<ShortlistContextValue | null>(null);

export function ShortlistProvider({ children }: { children: React.ReactNode }) {
  const [map, setMap] = useState<Record<number, ShortlistItem>>({});

  const toggle = useCallback((item: ShortlistItem) => {
    setMap((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = item;
      return next;
    });
  }, []);

  const clear = useCallback(() => setMap({}), []);

  const value = useMemo<ShortlistContextValue>(() => {
    const items = Object.values(map);
    return {
      items,
      count: items.length,
      has: (id: number) => Boolean(map[id]),
      toggle,
      clear,
    };
  }, [map, toggle, clear]);

  return <ShortlistContext.Provider value={value}>{children}</ShortlistContext.Provider>;
}

export function useShortlist(): ShortlistContextValue {
  const ctx = useContext(ShortlistContext);
  if (!ctx) throw new Error("useShortlist must be used within ShortlistProvider");
  return ctx;
}

// Builds a WhatsApp-shareable summary of the shortlisted listings. The client
// opens wa.me with this prefilled text and sends it to whoever they choose —
// no sign-up, no forced broker assignment.
export function buildShortlistMessage(items: ShortlistItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map((it, i) => {
    const loc = it.locality ? ` — ${it.locality}` : "";
    const price = it.priceLabel ? ` (${it.priceLabel})` : "";
    const link = it.href ? ` ${window.location.origin}${it.href}` : "";
    return `${i + 1}. ${it.title}${loc}${price}${link}`;
  });
  return `Hi, I'm interested in these ${items.length} PropAI listing(s):\n\n${lines.join("\n")}\n\nPlease share more details.`;
}
