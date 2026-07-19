"use client";

import { useState, useEffect, useRef } from "react";
import * as api from "@/lib/api";

// Module-level cache: jid → { url, ts }
const _cache = new Map<string, { url: string; ts: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

export function useProfilePicture(jid: string | undefined | null) {
  const [url, setUrl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(new Set<string>());

  useEffect(() => {
    if (!jid || !jid.includes("@s.whatsapp.net")) {
      setUrl("");
      return;
    }

    const cached = _cache.get(jid);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      setUrl(cached.url);
      return;
    }

    if (fetchedRef.current.has(jid)) return;
    fetchedRef.current.add(jid);

    setLoading(true);
    api
      .getProfilePicture(jid)
      .then((res) => {
        const picUrl = res.url || "";
        _cache.set(jid, { url: picUrl, ts: Date.now() });
        setUrl(picUrl);
      })
      .catch(() => {
        setUrl("");
      })
      .finally(() => setLoading(false));
  }, [jid]);

  return { url, loading };
}
