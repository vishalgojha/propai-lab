"use client";

import { useEffect, useRef, useState } from "react";
import type { NaturalSearchResult } from "@/lib/natural-search";
import { slugify } from "@/lib/supabase";
import Link from "next/link";

type Props = {
  results: NaturalSearchResult[];
  token: string | null;
};

function formatPrice(value: number | null, unit?: string | null): string {
  if (value == null) return "";
  const u = (unit || "").toLowerCase();
  if (u === "cr" || u === "crore") return `₹${value % 1 === 0 ? value : value.toFixed(2)} Cr`;
  if (u === "lac" || u === "lakh") return `₹${value % 1 === 0 ? value : value.toFixed(1)} L`;
  if (u === "k" || u === "thousand") return `₹${Math.round(value).toLocaleString("en-IN")}K`;
  return `₹${value.toLocaleString("en-IN")}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export default function SearchMap({ results, token }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const geocoded = results.filter(
    (r) => r.latitude != null && r.longitude != null,
  );

  useEffect(() => {
    if (geocoded.length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    if (!token) {
      setError("Map token not configured.");
      return;
    }

    let mapboxgl: typeof import("mapbox-gl");
    let cleanup = () => {};

    (async () => {
      try {
        const mod = await import("mapbox-gl");
        mapboxgl = mod;

        (mapboxgl as unknown as { accessToken: string }).accessToken = token;

        const map = new mapboxgl.Map({
          container,
          style: "mapbox://styles/mapbox/dark-v11",
          center: [72.8777, 19.076],
          zoom: 11,
          attributionControl: false,
        });
        mapRef.current = map;

        map.on("error", (e: { error?: { message?: string } }) => {
          const msg = e?.error?.message ?? "";
          if (/401|403|unauthorized|Forbidden/i.test(msg)) {
            setError("Map token rejected — check token validity / URL restrictions.");
          } else if (msg) {
            setError(msg);
          }
        });

        if (geocoded.length > 1) {
          const bounds = new mod.LngLatBounds();
          for (const r of geocoded) {
            bounds.extend([r.longitude as number, r.latitude as number]);
          }
          map.fitBounds(bounds, { padding: 48, maxZoom: 14 });
        } else {
          map.setCenter([geocoded[0].longitude as number, geocoded[0].latitude as number]);
          map.setZoom(14);
        }

        for (const r of geocoded) {
          const buildingSlug = r.building_name ? slugify(r.building_name) : null;
          const localitySlug = r.micro_market ? slugify(r.micro_market) : null;
          const href = buildingSlug
            ? `/buildings/${buildingSlug}`
            : localitySlug
            ? `/localities/${localitySlug}`
            : null;

          const intentColor =
            r.intent === "RENT"
              ? "#22c55e"
              : r.intent === "SELL"
              ? "#3b82f6"
              : "#3EE88A";

          const priceText = r.price != null ? formatPrice(r.price, r.price_unit) : "Price on request";
          const parts = [r.bhk, r.furnishing, r.micro_market].filter(Boolean).join(" · ");

          const html = `
            <div style="font-family:system-ui,sans-serif;max-width:220px">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${intentColor}"></span>
                <span style="font-size:10px;color:#a1a1aa;text-transform:uppercase;letter-spacing:0.05em">${escapeHtml(r.intent || r.asset_type || "listing")}</span>
              </div>
              ${r.building_name ? `<div style="font-weight:600;font-size:13px;color:#fff;margin-bottom:2px">${escapeHtml(r.building_name)}</div>` : ""}
              <div style="font-size:18px;font-weight:700;color:#fff">${priceText}</div>
              ${parts ? `<div style="font-size:11px;color:#a1a1aa;margin-top:2px">${escapeHtml(parts)}</div>` : ""}
              ${href ? `<a href="${href}" style="display:inline-block;margin-top:6px;font-size:11px;font-weight:600;color:#3EE88A;text-decoration:none">View details →</a>` : ""}
            </div>
          `;

          const popup = new mod.Popup({ offset: 18, closeButton: false }).setHTML(html);

          const markerEl = document.createElement("div");
          markerEl.style.cssText = `
            width:14px;height:14px;border-radius:50%;
            background:${intentColor};
            border:2px solid rgba(0,0,0,0.4);
            cursor:pointer;
            box-shadow:0 0 8px ${intentColor}44;
            transition:transform 0.15s;
          `;
          markerEl.onmouseenter = () => { markerEl.style.transform = "scale(1.3)"; };
          markerEl.onmouseleave = () => { markerEl.style.transform = "scale(1)"; };

          new mod.Marker({ element: markerEl })
            .setLngLat([r.longitude as number, r.latitude as number])
            .setPopup(popup)
            .addTo(map);
        }

        cleanup = () => map.remove();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Map failed to load.");
      }
    })();

    return () => {
      cleanup();
      mapRef.current = null;
    };
  }, [geocoded, token]);

  if (geocoded.length === 0) return null;

  if (error) {
    return (
      <div className="flex w-full h-[360px] lg:h-[480px] flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-zinc-900/60 px-6 text-center">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
          <path d="M12 21s-6-5.686-6-10a6 6 0 1 1 12 0c0 4.314-6 10-6 10Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <circle cx="12" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <p className="text-sm text-zinc-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="w-full h-[360px] lg:h-[480px] rounded-2xl overflow-hidden border border-white/10 bg-zinc-900"
        aria-label="Map of search results"
      />
      <div className="absolute bottom-3 left-3 flex flex-wrap gap-1.5 text-[10px] text-zinc-400">
        <span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 backdrop-blur">
          <span className="h-2 w-2 rounded-full bg-green-500" /> {geocoded.length} on map
        </span>
        {results.length > geocoded.length && (
          <span className="inline-flex items-center gap-1 rounded-full bg-black/70 px-2 py-1 backdrop-blur">
            {results.length - geocoded.length} without coordinates
          </span>
        )}
      </div>
    </div>
  );
}
