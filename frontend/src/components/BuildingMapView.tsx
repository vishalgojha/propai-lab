"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from "@react-google-maps/api";
import { MapPin, Search, X } from "lucide-react";
import { getBuildings } from "@/lib/api";

type Building = {
  id?: number | string;
  building_id?: string;
  canonical_name?: string;
  micro_market?: string;
  developer?: string;
  address?: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
  observed_listings?: number;
  observed_brokers?: number;
  status?: string;
};

const mumbaiCenter = { lat: 19.076, lng: 72.8777 };
const containerStyle = { width: "100%", height: "min(66vh, 620px)" };

function coordinates(building: Building) {
  const lat = Number(building.latitude);
  const lng = Number(building.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function BuildingMapView() {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Building | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const googleMapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const { isLoaded, loadError } = useJsApiLoader({
    id: "propai-google-map",
    googleMapsApiKey: googleMapsKey,
  });

  useEffect(() => {
    let active = true;
    getBuildings(500, 0)
      .then((payload) => {
        if (active) setBuildings(Array.isArray(payload?.buildings) ? payload.buildings : []);
      })
      .catch(() => active && setError("Building data could not be loaded right now."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return buildings.filter((building) => {
      if (!needle) return true;
      return [building.canonical_name, building.micro_market, building.address, building.developer, building.building_id]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [buildings, query]);

  const mapped = useMemo(
    () => filtered.map((building) => ({ building, position: coordinates(building) })).filter((item) => item.position),
    [filtered],
  );

  const markerIcon = isLoaded && typeof window !== "undefined"
    ? {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#22C55E",
        fillOpacity: 1,
        strokeColor: "#0F1115",
        strokeWeight: 2,
      }
    : undefined;

  return (
    <section className="space-y-4 p-4 sm:p-6 lg:p-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Market intelligence</p>
          <h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold text-text-primary">
            <MapPin className="h-5 w-5 text-accent" /> Market Map
          </h1>
          <p className="mt-1 text-sm text-text-muted">Explore buildings with coordinates from the building index.</p>
        </div>
        <div className="flex w-full max-w-md items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search buildings, localities, developers"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear map search"><X className="h-4 w-4 text-text-muted" /></button>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
        <span className="rounded-full border border-border bg-surface px-3 py-1">{mapped.length} mapped buildings</span>
        <span>Showing only database rows with latitude and longitude.</span>
      </div>

      {error && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
      {!googleMapsKey && (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-muted">
          Add <code className="text-text-primary">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to the frontend service to enable the map.
        </div>
      )}
      {loadError && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">Google Maps could not be loaded.</div>}

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated">
        {loading ? (
          <div className="flex h-[min(66vh,620px)] items-center justify-center text-sm text-text-muted">Loading building data…</div>
        ) : !googleMapsKey ? (
          <div className="flex h-[min(66vh,620px)] items-center justify-center px-6 text-center text-sm text-text-muted">Google Maps is not configured for this frontend yet.</div>
        ) : !isLoaded ? (
          <div className="flex h-[min(66vh,620px)] items-center justify-center text-sm text-text-muted">Loading Google Maps…</div>
        ) : (
          <GoogleMap mapContainerStyle={containerStyle} center={mumbaiCenter} zoom={11} options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}>
            {mapped.map(({ building, position }) => (
              <Marker key={`${building.id ?? building.building_id ?? building.canonical_name}`} position={position!} icon={markerIcon} onClick={() => setSelected(building)} />
            ))}
            {selected && coordinates(selected) && (
              <InfoWindow position={coordinates(selected)!} onCloseClick={() => setSelected(null)}>
                <div className="min-w-[210px] space-y-1 text-slate-900">
                  <div className="font-semibold">{selected.canonical_name || "Unnamed building"}</div>
                  <div className="text-xs">{selected.micro_market || selected.address || "Location not specified"}</div>
                  <div className="text-xs">{selected.observed_listings ?? 0} listings · {selected.observed_brokers ?? 0} brokers</div>
                  {selected.building_id && <Link className="text-xs font-medium text-emerald-700 underline" href={`/buildings/${encodeURIComponent(selected.building_id)}`}>Open building</Link>}
                </div>
              </InfoWindow>
            )}
          </GoogleMap>
        )}
      </div>

      {!loading && mapped.length === 0 && <p className="text-sm text-text-muted">No mapped buildings match this search.</p>}
    </section>
  );
}
