"use client";

import { useEffect, useRef } from "react";
import type { BuildingOnMap } from "@/lib/localities";

type Props = {
  locality: string;
  buildings: BuildingOnMap[];
};

function formatPrice(value: number | null): string {
  if (value == null) return "—";
  if (value >= 1_00_00_000) {
    const cr = value / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(1)} Cr`;
  }
  if (value >= 1_00_000) {
    const l = value / 1_00_000;
    return `₹${l % 1 === 0 ? l : l.toFixed(1)} L`;
  }
  return `₹${value.toLocaleString("en-IN")}`;
}

export default function LocalityMap({ locality, buildings }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);

  const geocoded = buildings.filter(
    (b) => b.latitude != null && b.longitude != null,
  );

  useEffect(() => {
    if (geocoded.length === 0) return;
    const container = containerRef.current;
    if (!container) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      console.warn("NEXT_PUBLIC_MAPBOX_TOKEN is not set — map cannot render.");
      return;
    }

    let mapboxgl: typeof import("mapbox-gl");
    let popupApi: typeof import("mapbox-gl").Popup;
    let cleanup = () => {};

    (async () => {
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
              ? formatPrice(b.minPrice)
              : `${formatPrice(b.minPrice)} – ${formatPrice(b.maxPrice)}`
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
    })();

    return () => {
      cleanup();
      mapRef.current = null;
    };
  }, [geocoded]);

  if (geocoded.length === 0) {
    if (process.env.NODE_ENV !== "production") {
      console.log(
        `LocalityMap: ${buildings.length - geocoded.length} of ${buildings.length} buildings unmapped for "${locality}" — no map rendered.`,
      );
    }
    return null;
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(
      `LocalityMap: ${buildings.length - geocoded.length} of ${buildings.length} buildings unmapped for "${locality}".`,
    );
  }

  return (
    <div
      ref={containerRef}
      className="w-full h-[420px] lg:h-[480px] rounded-xl overflow-hidden border border-white/10 bg-zinc-900"
      aria-label={`Map of properties in ${locality}`}
    />
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
