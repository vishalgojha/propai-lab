"use client";

import { useEffect, useRef, useState } from "react";
import type { BuildingOnMap } from "@/lib/localities";

type Props = {
  locality: string;
  buildings: BuildingOnMap[];
  token: string | null;
};

function formatPrice(value: number | null, unit?: string | null): string {
  if (value == null) return "—";
  // value is in the unit's native scale (Cr / Lac / K / abs), not absolute rupees.
  const u = (unit || "").toLowerCase();
  if (u === "cr" || u === "crore") return `₹${value % 1 === 0 ? value : value.toFixed(2)} Cr`;
  if (u === "lac" || u === "lakh") return `₹${value % 1 === 0 ? value : value.toFixed(1)} L`;
  if (u === "k" || u === "thousand") return `₹${Math.round(value).toLocaleString("en-IN")}K`;
  if (u === "abs") return `₹${Math.round(value).toLocaleString("en-IN")}`;
  return `₹${value.toLocaleString("en-IN")}`;
}

export default function LocalityMap({ locality, buildings, token }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const geocoded = buildings.filter(
    (b) => b.latitude != null && b.longitude != null,
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
    let popupApi: typeof import("mapbox-gl").Popup;
    let cleanup = () => {};

    (async () => {
      try {
        const mod = await import("mapbox-gl");
        mapboxgl = mod;
        popupApi = mod.Popup;

        (mapboxgl as unknown as { accessToken: string }).accessToken = token;

        const map = new mapboxgl.Map({
          container,
          style: "mapbox://styles/mapbox/light-v11",
          center:
            geocoded.length === 1
              ? [geocoded[0].longitude as number, geocoded[0].latitude as number]
              : [0, 0],
          zoom: geocoded.length === 1 ? 14 : 11,
          attributionControl: false,
        });
        mapRef.current = map;

        map.on("error", (e: { error?: { message?: string } }) => {
          const msg = e?.error?.message ?? "";
          // 401/403 usually means an invalid/expired/URL-restricted token.
          if (/401|403|unauthorized|Forbidden/i.test(msg)) {
            setError("Map token rejected — check token validity / URL restrictions.");
          } else if (msg) {
            setError(msg);
          }
        });

        if (geocoded.length > 1) {
          const bounds = new (await import("mapbox-gl")).LngLatBounds();
          for (const b of geocoded) {
            bounds.extend([b.longitude as number, b.latitude as number]);
          }
          map.fitBounds(bounds, { padding: 64, maxZoom: 15 });
        }

        for (const b of geocoded) {
          const priceText =
            b.minPrice != null && b.maxPrice != null
              ? b.minPrice === b.maxPrice
                ? formatPrice(b.minPrice, b.priceUnit)
                : `${formatPrice(b.minPrice, b.priceUnit)} – ${formatPrice(b.maxPrice, b.priceUnit)}`
              : "Price on request";

          const html = `
            <div class="propai-popup">
              <h3 class="propai-popup__name">${escapeHtml(b.name)}</h3>
              ${b.bhkRange ? `<p class="propai-popup__bhk">${escapeHtml(b.bhkRange)}</p>` : ""}
              <p class="propai-popup__price">${priceText}</p>
              <p class="propai-popup__count">${b.listingCount} active listing${b.listingCount === 1 ? "" : "s"}</p>
            </div>
          `;

          const popup = new popupApi({
            offset: 18,
            closeButton: false,
            className: "propai-map-popup",
          }).setHTML(html);

          const marker = new mapboxgl.Marker({ color: "#3EE88A" })
            .setLngLat([b.longitude as number, b.latitude as number])
            .setPopup(popup)
            .addTo(map);
          void marker;
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
  }, [geocoded]);

  if (geocoded.length === 0) return null;

  if (error) {
    return (
      <div className="flex w-full h-[280px] lg:h-[320px] flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-zinc-900/60 px-6 text-center">
        <MapPinErrorIcon />
        <p className="text-sm text-zinc-400">{error}</p>
        <p className="text-xs text-zinc-600">
          Building listings below are still available without the map.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-[280px] lg:h-[320px] rounded-xl overflow-hidden border border-white/10 bg-zinc-900"
      aria-label={`Map of properties in ${locality}`}
    />
  );
}

function MapPinErrorIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
      <path
        d="M12 21s-6-5.686-6-10a6 6 0 1 1 12 0c0 4.314-6 10-6 10Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="11" r="2.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
