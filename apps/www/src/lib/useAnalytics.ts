"use client";

import { useCallback, useEffect, useRef } from "react";

const COOKIE_NAME = "propai_vid";
const COOKIE_TTL_DAYS = 365;

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : null;
}

function writeCookie(name: string, value: string, days: number) {
  if (typeof document === "undefined") return;
  const maxAge = days * 24 * 60 * 60;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; samesite=lax`;
}

function generateId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `v_${rand}`;
}

export type TrackEvent =
  | "page_view"
  | "listing_view"
  | "search"
  | "contact_click"
  | "shortlist_add"
  | "shortlist_remove"
  | "bundle_send";

export type TrackMeta = {
  listingId?: number | null;
  query?: string;
  asset?: string;
  page?: string;
  extra?: Record<string, unknown>;
};

// Anonymous analytics: a visitor id is stored in a first-party cookie (no
// sign-up, no PII). Events are fire-and-forget POSTs to /api/track. Failures
// are swallowed so analytics never affects the UI.
export function useAnalytics() {
  const vidRef = useRef<string | null>(null);

  useEffect(() => {
    let id = readCookie(COOKIE_NAME);
    if (!id) {
      id = generateId();
      writeCookie(COOKIE_NAME, id, COOKIE_TTL_DAYS);
    }
    vidRef.current = id;
  }, []);

  const track = useCallback((event: TrackEvent, meta: TrackMeta = {}) => {
    const vid = vidRef.current ?? readCookie(COOKIE_NAME) ?? generateId();
    vidRef.current = vid;
    try {
      fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          visitor_id: vid,
          event,
          listing_id: meta.listingId ?? null,
          query: meta.query ?? null,
          asset: meta.asset ?? null,
          page: meta.page ?? (typeof window !== "undefined" ? window.location.pathname : null),
          extra: meta.extra ?? null,
        }),
      }).catch(() => {});
    } catch {
      /* never block the UI */
    }
  }, []);

  return { track };
}
