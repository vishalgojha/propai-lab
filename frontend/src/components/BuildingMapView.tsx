"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from "@react-google-maps/api";
import { MapPin, Search, X } from "lucide-react";
import ListingCard, { type ListingItem } from "@/components/ListingCard";
import ResizablePanel from "@/components/ResizablePanel";
import { getBuildings, marketSearchListings, parseSearchQuery } from "@/lib/api";

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

type MarketListing = ListingItem & {
  latitude?: number | string | null;
  longitude?: number | string | null;
  building_id?: string;
};

type LatLng = { lat: number; lng: number };

type ListingGroup = {
  key: string;
  name: string;
  items: MarketListing[];
  position: LatLng | null;
  building: Building;
};

type MapController = {
  panTo: (position: LatLng) => void;
  setZoom: (zoom: number) => void;
  setCenter: (position: LatLng) => void;
  fitBounds: (bounds: google.maps.LatLngBounds, padding?: number) => void;
};

const mumbaiCenter = { lat: 19.076, lng: 72.8777 };
const containerStyle = { width: "100%", height: "100%" };

function coordinates(item: { latitude?: number | string | null; longitude?: number | string | null }) {
  if (item.latitude === null || item.latitude === undefined || item.latitude === ""
    || item.longitude === null || item.longitude === undefined || item.longitude === "") {
    return null;
  }
  const lat = Number(item.latitude);
  const lng = Number(item.longitude);
  return Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    && (lat !== 0 || lng !== 0)
    ? { lat, lng }
    : null;
}

function normalizeBhk(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const raw = text.replace(/\s*bhk\b/i, "").trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return `${numeric} BHK`;
  return /bhk/i.test(text) ? text : `${text} BHK`;
}

function normalizeIntent(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "sell" || text === "sale") return "SELL";
  if (text === "rent" || text === "lease") return "RENT";
  return text.toUpperCase();
}

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function BuildingMapView() {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [browseListings, setBrowseListings] = useState<MarketListing[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [pendingPan, setPendingPan] = useState<LatLng | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<MapController | null>(null);
  const listingRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const googleMapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const { isLoaded, loadError } = useJsApiLoader({
    id: "propai-google-map",
    googleMapsApiKey: googleMapsKey,
  });

  useEffect(() => {
    let active = true;
    Promise.all([
      getBuildings(500, 0),
      marketSearchListings({ limit: 100, offset: 0, group_by_building: false }),
    ])
      .then(([buildingPayload, listingPayload]) => {
        if (!active) return;
        setBuildings(Array.isArray(buildingPayload?.buildings) ? buildingPayload.buildings : []);
        setBrowseListings(Array.isArray(listingPayload?.results) ? listingPayload.results : []);
      })
      .catch(() => active && setError("Market data could not be loaded right now."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const searchGroups = useMemo<ListingGroup[]>(() => {
    const groups = new Map<string, ListingGroup>();
    listings.forEach((item) => {
      const name = item.building_name?.trim() || "Unknown building";
      const locality = item.micro_market?.trim() || item.location_label?.trim() || "";
      const key = `listing-${name.toLowerCase()}|${locality.toLowerCase()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push(item);
        if (!existing.position) existing.position = coordinates(item);
        return;
      }
      const position = coordinates(item);
      groups.set(key, {
        key,
        name,
        items: [item],
        position,
        building: {
          canonical_name: name,
          micro_market: locality,
          address: item.building_address,
          latitude: position?.lat,
          longitude: position?.lng,
          building_id: item.building_id,
          observed_listings: 1,
        },
      });
    });
    return Array.from(groups.values());
  }, [listings]);

  const browseGroups = useMemo<ListingGroup[]>(() => {
    const groups: Array<ListingGroup | null> = buildings.map((building) => {
      const position = coordinates(building);
      if (!position) return null;
      return {
        key: `building-${building.id ?? building.building_id ?? building.canonical_name ?? "unknown"}`,
        name: building.canonical_name || "Unnamed building",
        items: [] as MarketListing[],
        position,
        building,
      };
    });
    return groups.filter((group): group is ListingGroup => Boolean(group));
  }, [buildings]);

  const activeGroups = searchActive ? searchGroups : browseGroups;
  const selectedGroup = activeGroups.find((group) => group.key === selectedKey) ?? null;
  const mappedCount = activeGroups.filter((group) => group.position).length;

  useEffect(() => {
    if (!isLoaded || !mapRef.current || activeGroups.length === 0 || typeof window === "undefined") return;
    const points = activeGroups.map((group) => group.position).filter((position): position is LatLng => Boolean(position));
    if (points.length === 0) return;
    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend(point));
    if (points.length === 1) {
      mapRef.current.setCenter(points[0]);
      mapRef.current.setZoom(14);
    } else {
      mapRef.current.fitBounds(bounds, 48);
    }
  }, [activeGroups, isLoaded]);

  useEffect(() => {
    if (!selectedKey || !searchActive) return;
    listingRefs.current[selectedKey]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedKey, searchActive]);

  useEffect(() => {
    if (!pendingPan || !mapRef.current) return;
    mapRef.current.panTo(pendingPan);
    mapRef.current.setZoom(14);
    setPendingPan(null);
  }, [pendingPan]);

  function focusGroup(group: ListingGroup) {
    setSelectedKey(group.key);
    setPendingPan(group.position);
  }

  function clearSearch() {
    setQuery("");
    setSearchActive(false);
    setListings([]);
    setSelectedKey("");
    setError(null);
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    setError(null);
    if (!trimmed) {
      clearSearch();
      return;
    }

    setSearchLoading(true);
    try {
      const parsed = await parseSearchQuery(trimmed);
      const localities = Array.isArray(parsed?.localities) ? parsed.localities : [];
      const payload = await marketSearchListings({
        intent: normalizeIntent(parsed?.intent),
        bhk: normalizeBhk(parsed?.bhk),
        building: parsed?.building || "",
        micro_market: parsed?.locality || localities[0] || "",
        price_min: finitePositive(parsed?.minPrice),
        price_max: finitePositive(parsed?.maxPrice),
        furnishing: parsed?.furnishing || "",
        limit: 100,
        offset: 0,
        group_by_building: false,
      });
      setListings(Array.isArray(payload?.results) ? payload.results : []);
      setSearchActive(true);
      setSelectedKey("");
    } catch {
      setError("Could not search listings right now.");
    } finally {
      setSearchLoading(false);
    }
  }

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
    <section className="flex min-h-[calc(100dvh-44px)] flex-col gap-3 p-3 sm:p-4 lg:p-5">
      <div className="flex shrink-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">Market intelligence</p>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-text-primary sm:text-2xl">
            <MapPin className="h-5 w-5 text-accent" strokeWidth={2} /> Market Map
          </h1>
          <p className="mt-1 text-xs text-text-muted sm:text-sm">Explore live inventory by location, price and configuration.</p>
        </div>
        <form onSubmit={handleSearch} className="flex w-full max-w-2xl items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 shadow-sm">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Try: 3 BHK for rent in Bandra West"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
            {query && <button type="button" onClick={clearSearch} aria-label="Clear map search"><X className="h-4 w-4 text-text-muted" /></button>}
          <button type="submit" disabled={searchLoading} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-background disabled:opacity-60">
            {searchLoading ? "Searching…" : "Search"}
          </button>
        </form>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-text-muted">
        <span className="rounded-full border border-border bg-surface px-3 py-1.5 font-medium text-text-primary">{searchActive ? `${listings.length} listings` : `${browseListings.length} latest listings`}</span>
        <span className="rounded-full border border-border/70 px-3 py-1.5">{searchActive ? `${mappedCount} mapped buildings` : `${mappedCount} mapped buildings`}</span>
        <span className="hidden sm:inline">Click a marker or listing to inspect the building.</span>
      </div>

      {error && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
      {!googleMapsKey && <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-muted">Add <code className="text-text-primary">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to the frontend service to enable the map.</div>}
      {loadError && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">Google Maps could not be loaded.</div>}

      <div className="flex min-h-[560px] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated lg:min-h-0 lg:flex-row">
        <ResizablePanel
          defaultWidth={440}
          minWidth={300}
          maxWidth={650}
          storageKey="market-map-panel-width"
          mobile={isMobile}
          className="max-w-full shrink-0 border-b border-border bg-background lg:border-b-0 lg:border-r"
        >
          <div className="h-full min-h-0 overflow-y-auto p-3">
            <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-center justify-between rounded-lg bg-background/95 px-2 py-2 backdrop-blur">
              <div>
                <p className="text-sm font-semibold text-text-primary">{searchActive ? "Matching listings" : "Latest listings"}</p>
                <p className="text-xs text-text-muted">{searchActive ? "Click a card to focus its building." : "Listings without verified coordinates remain visible here."}</p>
              </div>
            </div>

            {!searchActive && browseListings.map((item, index) => (
              <div key={`${item.listing_id ?? item.fingerprint ?? index}`} className="mb-3">
                <ListingCard item={item} compact />
              </div>
            ))}
            {searchActive && listings.length === 0 && <div className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">No listings match this search.</div>}
            {searchActive && listings.length > 0 && mappedCount === 0 && <div className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">Listings found, but none have mapped building coordinates yet.</div>}
            {searchActive && searchGroups.map((group) => (
              <div
                key={group.key}
                ref={(element) => { listingRefs.current[group.key] = element; }}
                onMouseEnter={() => setSelectedKey(group.key)}
                onClick={() => focusGroup(group)}
                className={`mb-3 cursor-pointer rounded-xl border p-2 transition ${selectedKey === group.key ? "border-accent/70 bg-accent/5" : "border-border bg-surface"}`}
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{group.name}</p>
                  <span className="shrink-0 text-xs text-text-muted">{group.items.length} listing{group.items.length === 1 ? "" : "s"}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item, index) => <ListingCard key={`${item.listing_id ?? item.fingerprint ?? index}`} item={item} compact />)}
                </div>
              </div>
            ))}
            {!searchActive && browseGroups.map((group) => (
              <button key={group.key} type="button" onClick={() => focusGroup(group)} className={`mb-2 w-full rounded-xl border p-3 text-left transition ${selectedKey === group.key ? "border-accent/70 bg-accent/5" : "border-border bg-surface hover:border-accent/40"}`}>
                <p className="truncate text-sm font-semibold text-text-primary">{group.name}</p>
                <p className="mt-1 text-xs text-text-muted">{group.building.micro_market || group.building.address || "Location not specified"}</p>
                <p className="mt-2 text-xs text-text-muted">{group.building.observed_listings ?? 0} listings · {group.building.observed_brokers ?? 0} brokers</p>
              </button>
            ))}
          </div>
        </ResizablePanel>

        <div className="min-h-0 min-w-0 flex-1 bg-[#dbeef2]">
          {loading ? <div className="flex h-full min-h-[520px] items-center justify-center text-sm text-text-muted">Loading market data…</div>
            : !googleMapsKey ? <div className="flex h-full min-h-[520px] items-center justify-center px-6 text-center text-sm text-text-muted">Google Maps is not configured for this frontend yet.</div>
              : !isLoaded ? <div className="flex h-full min-h-[520px] items-center justify-center text-sm text-text-muted">Loading Google Maps…</div>
                : <GoogleMap
                  mapContainerStyle={containerStyle}
                  center={mumbaiCenter}
                  zoom={11}
                  onLoad={(map) => { mapRef.current = map; }}
                  onUnmount={() => { mapRef.current = null; }}
                  options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}
                >
                  {activeGroups.filter((group) => group.position).map((group) => (
                    <Marker key={group.key} position={group.position!} icon={markerIcon} onClick={() => focusGroup(group)} />
                  ))}
                  {selectedGroup?.position && (
                    <InfoWindow position={selectedGroup.position} onCloseClick={() => setSelectedKey("")}>
                      <div className="min-w-[210px] space-y-1 text-slate-900">
                        <div className="font-semibold">{selectedGroup.name}</div>
                        <div className="text-xs">{selectedGroup.building.address || selectedGroup.building.micro_market || "Location not specified"}</div>
                        <div className="text-xs">{searchActive ? `${selectedGroup.items.length} matching listings` : `${selectedGroup.building.observed_listings ?? 0} listings · ${selectedGroup.building.observed_brokers ?? 0} brokers`}</div>
                        {selectedGroup.building.building_id && <Link className="text-xs font-medium text-emerald-700 underline" href={`/buildings/${encodeURIComponent(selectedGroup.building.building_id)}`}>Open building</Link>}
                      </div>
                    </InfoWindow>
                  )}
                </GoogleMap>}
        </div>
      </div>

      {!loading && searchActive && listings.length === 0 && <p className="text-sm text-text-muted">No listings match this search.</p>}
      {!loading && !searchActive && browseGroups.length === 0 && <p className="text-sm text-text-muted">No mapped buildings are available.</p>}
    </section>
  );
}
