"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { GoogleMap, InfoWindow, Marker, useJsApiLoader } from "@react-google-maps/api";
import { ArrowUpRight, MapPin, MessageSquare, Search, X } from "lucide-react";
import ListingCard, { type ListingItem } from "@/components/ListingCard";
import ResizablePanel from "@/components/ResizablePanel";
import { getListing, marketSearchListings, parseSearchQuery, resolveBrokerContact } from "@/lib/api";
import { formatListingValue } from "@/lib/format";

type MarketListing = ListingItem & {
  latitude?: number | string | null;
  longitude?: number | string | null;
};

type LatLng = { lat: number; lng: number };

type ListingCluster = {
  key: string;
  name: string;
  items: MarketListing[];
  position: LatLng | null;
  locality: string;
};

type MapController = {
  panTo: (position: LatLng) => void;
  setZoom: (zoom: number) => void;
  setCenter: (position: LatLng) => void;
  fitBounds: (bounds: google.maps.LatLngBounds, padding?: number) => void;
};

type MarketSnapshot = {
  listings: MarketListing[];
  fetchedAt: number;
};

const MARKET_CACHE_TTL_MS = 45_000;
let marketSnapshotCache: MarketSnapshot | null = null;
let marketSnapshotRequest: Promise<MarketSnapshot> | null = null;

function loadMarketSnapshot(): Promise<MarketSnapshot> {
  const now = Date.now();
  if (marketSnapshotCache && now - marketSnapshotCache.fetchedAt < MARKET_CACHE_TTL_MS) {
    return Promise.resolve(marketSnapshotCache);
  }
  if (marketSnapshotRequest) return marketSnapshotRequest;

  marketSnapshotRequest = Promise.allSettled([
    marketSearchListings({ limit: 100, offset: 0, group_by_building: false }),
  ])
    .then(([listingResult]) => {
      if (listingResult.status === "rejected") {
        throw listingResult.reason instanceof Error ? listingResult.reason : new Error("Market listings unavailable");
      }
      const listingPayload = listingResult.value;
      const snapshot: MarketSnapshot = {
        listings: Array.isArray(listingPayload?.results) ? listingPayload.results : [],
        fetchedAt: Date.now(),
      };
      marketSnapshotCache = snapshot;
      return snapshot;
    })
    .finally(() => {
      marketSnapshotRequest = null;
    });

  return marketSnapshotRequest;
}

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
    && lat >= 18.5 && lat <= 19.6 && lng >= 72.5 && lng <= 73.5
    && (lat !== 0 || lng !== 0)
    ? { lat, lng }
    : null;
}

function normalizeBhk(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const raw = text.replace(/\s*bhk\b/i, "").trim();
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return String(numeric);
  return raw || text;
}

function normalizeIntent(value: unknown) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "sell" || text === "sale") return "SELL";
  if (text === "rent" || text === "lease") return "RENT";
  return text.toUpperCase();
}

function markerColor(item: Pick<MarketListing, "intent" | "transaction_type" | "asset_type">) {
  const transaction = String(item.transaction_type || item.intent || "").toLowerCase();
  const commercial = String(item.asset_type || "").toLowerCase() === "commercial";
  if (commercial && /^(rent|lease|rental)$/.test(transaction)) return "#A78BFA";
  if (commercial && /^(sell|sale|buy|outright)$/.test(transaction)) return "#F59E0B";
  if (/^(rent|lease|rental)$/.test(transaction)) return "#22C55E";
  if (/^(sell|sale|buy|outright)$/.test(transaction)) return "#60A5FA";
  return "#94A3B8";
}

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function formatConfiguration(value: unknown, fallback?: unknown) {
  const text = String(value ?? "").trim();
  const fallbackText = String(fallback ?? "").trim();
  if (!text && !fallbackText) return "";
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    if (/\b(?:bhk|rk|bed|bedroom)/i.test(fallbackText)) return fallbackText;
    const number = Number(text);
    return `${Number.isInteger(number) ? number : number} BHK`;
  }
  return text || fallbackText;
}

function formatDetailPrice(data: Record<string, any>) {
  if (data.price_formatted) return String(data.price_formatted);
  if (data.price_raw_text) return String(data.price_raw_text);
  const amount = Number(data.monthly_rent ?? data.total_asking_price ?? data.price);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const formatted = `₹${amount.toLocaleString("en-IN")}`;
  return String(data.intent || data.transaction_type).toUpperCase() === "RENT" ? `${formatted}/month` : formatted;
}

export function BuildingMapView() {
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [browseListings, setBrowseListings] = useState<MarketListing[]>(() => marketSnapshotCache?.listings ?? []);
  const [selectedKey, setSelectedKey] = useState("");
  const [pendingPan, setPendingPan] = useState<LatLng | null>(null);
  const [loading, setLoading] = useState(() => !marketSnapshotCache);
  const [isMobile, setIsMobile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedListing, setSelectedListing] = useState<MarketListing | null>(null);
  const [listingDetail, setListingDetail] = useState<Record<string, any> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [contacting, setContacting] = useState(false);
  const mapRef = useRef<MapController | null>(null);
  const listingRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const googleMapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
  const { isLoaded, loadError } = useJsApiLoader({
    id: "propai-google-map",
    googleMapsApiKey: googleMapsKey,
  });

  useEffect(() => {
    let active = true;
    loadMarketSnapshot()
      .then((snapshot) => {
        if (!active) return;
        setBrowseListings(snapshot.listings);
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

  const clusterListings = (source: MarketListing[]) => {
    const groups = new Map<string, ListingCluster>();
    source.forEach((item) => {
      const name = String(item.building_name || item.location_label || item.micro_market || "Property").trim();
      const locality = item.micro_market?.trim() || item.location_label?.trim() || "";
      const key = `${name.toLowerCase()}|${locality.toLowerCase()}`;
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
        locality,
      });
    });
    return Array.from(groups.values());
  };

  const searchGroups = useMemo<ListingCluster[]>(() => clusterListings(listings), [listings]);
  const browseGroups = useMemo<ListingCluster[]>(() => clusterListings(browseListings), [browseListings]);

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

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const timer = window.setTimeout(() => {
      void performSearch(trimmed);
    }, 450);
    return () => window.clearTimeout(timer);
  }, [query]);

  function focusGroup(group: ListingCluster) {
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

  async function inspectListing(item: MarketListing) {
    if (!item.listing_id) return;
    setSelectedListing(item);
    setListingDetail(null);
    setDetailLoading(true);
    try {
      setListingDetail(await getListing(item.listing_id));
    } catch {
      setError("This listing could not be opened. It may have been removed.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function contactBroker(listingId: number) {
    setContacting(true);
    const contactWindow = window.open("", "_blank");
    try {
      const { contact_url } = await resolveBrokerContact(listingId);
      if (contactWindow) {
        contactWindow.opener = null;
        contactWindow.location.assign(contact_url);
      } else {
        window.location.assign(contact_url);
      }
    } catch {
      contactWindow?.close();
      setError("The broker contact could not be opened right now.");
    } finally {
      setContacting(false);
    }
  }

  async function performSearch(trimmed: string) {
    setError(null);
    setSearchActive(true);
    setListings([]);
    setSelectedKey("");
    setSearchLoading(true);
    try {
      // Typeahead terms should be searchable immediately without spending a
      // parser/LLM request on every partial word ("b", "ba", "ban...").
      if (!/\s/.test(trimmed)) {
        const payload = await marketSearchListings({
          q: trimmed,
          limit: 100,
          offset: 0,
          group_by_building: false,
        });
        setListings(Array.isArray(payload?.results) ? payload.results : []);
        return;
      }
      let parsed: Awaited<ReturnType<typeof parseSearchQuery>> = {};
      try {
        parsed = await parseSearchQuery(trimmed);
      } catch {
        // Plain building searches should still work if query interpretation is unavailable.
      }
      const localities = Array.isArray(parsed?.localities) ? parsed.localities : [];
      const payload = await marketSearchListings({
        intent: normalizeIntent(parsed?.intent),
        bhk: normalizeBhk(parsed?.bhk),
        building: parsed?.building || (!parsed?.bhk && !parsed?.intent && !parsed?.locality ? trimmed : ""),
        micro_market: parsed?.locality || localities[0] || "",
        price_min: finitePositive(parsed?.minPrice),
        price_max: finitePositive(parsed?.maxPrice),
        furnishing: parsed?.furnishing || "",
        limit: 100,
        offset: 0,
        group_by_building: false,
      });
      setListings(Array.isArray(payload?.results) ? payload.results : []);
    } catch {
      setError("Could not search listings right now.");
    } finally {
      setSearchLoading(false);
    }
  }

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      clearSearch();
      return;
    }
    void performSearch(trimmed);
  }

  const markerIcon = (item: MarketListing) => isLoaded && typeof window !== "undefined"
    ? {
        path: window.google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: markerColor(item),
        fillOpacity: 1,
        strokeColor: "#0F1115",
        strokeWeight: 2,
      }
    : undefined;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 sm:p-4 lg:h-[calc(100dvh-44px)] lg:overflow-hidden lg:p-5">
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
        {!loading && <>
          <span className="rounded-full border border-border bg-surface px-3 py-1.5 font-medium text-text-primary">{searchActive ? `${listings.length} listings` : `${browseListings.length} latest listings`}</span>
          <span className="rounded-full border border-border/70 px-3 py-1.5">{mappedCount} mapped listing clusters</span>
        </>}
        <span className="hidden sm:inline">Every marker and card comes from a live listing. Click a listing for its extracted details.</span>
      </div>

      {error && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>}
      {!googleMapsKey && <div className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-muted">Add <code className="text-text-primary">NEXT_PUBLIC_GOOGLE_MAPS_API_KEY</code> to the frontend service to enable the map.</div>}
      {loadError && <div className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">Google Maps could not be loaded.</div>}

      <div className="flex min-h-0 min-w-0 flex-none flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated lg:flex-1 lg:flex-row-reverse">
        <ResizablePanel
          defaultWidth={700}
          minWidth={420}
          maxWidth={820}
          storageKey="market-map-panel-width"
          mobile={isMobile}
          className="order-last h-[52dvh] max-h-[620px] min-h-[300px] max-w-full shrink-0 border-b border-border bg-background lg:order-none lg:h-full lg:max-h-none lg:min-h-0 lg:border-b-0 lg:border-r"
        >
          <div className="market-map-listings-container h-full min-h-0 overflow-y-auto p-3">
            <div className="sticky top-0 z-10 -mx-1 mb-3 flex items-center justify-between rounded-lg bg-background/95 px-2 py-2 backdrop-blur">
              <div>
                <p className="text-sm font-semibold text-text-primary">{searchActive ? "Matching listings" : "Latest listings"}</p>
                <p className="text-xs text-text-muted">{searchActive ? "Click a card to focus matching listings." : "Listings without verified coordinates remain visible here."}</p>
              </div>
            </div>

            {!searchActive && <div className="market-map-listings-grid">
              {browseListings.map((item, index) => (
                <div
                  key={`${item.listing_id ?? item.fingerprint ?? index}`}
                  className="cursor-pointer transition-transform hover:-translate-y-0.5"
                  role={item.listing_id ? "link" : undefined}
                  tabIndex={item.listing_id ? 0 : undefined}
                  onClick={(event) => {
                    if (item.listing_id && !(event.target as HTMLElement).closest("button,a")) void inspectListing(item);
                  }}
                  onKeyDown={(event) => {
                    if (item.listing_id && (event.key === "Enter" || event.key === " ")) void inspectListing(item);
                  }}
                >
                  <ListingCard item={item} compact onContactBroker={contactBroker} contacting={contacting} />
                </div>
              ))}
            </div>}
            {searchActive && searchLoading && <div className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">Searching live listings…</div>}
            {searchActive && !searchLoading && listings.length === 0 && <div className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">No listings match this search.</div>}
            {searchActive && listings.length > 0 && mappedCount === 0 && <div className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-muted">Listings found, but none have coordinates yet.</div>}
            {searchActive && searchGroups.map((group) => (
              <div
                key={group.key}
                ref={(element) => { listingRefs.current[group.key] = element; }}
                onMouseEnter={() => setSelectedKey(group.key)}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("button,a")) return;
                  focusGroup(group);
                }}
                className={`mb-3 cursor-pointer rounded-xl border p-2 transition ${selectedKey === group.key ? "border-accent/70 bg-accent/5" : "border-border bg-surface"}`}
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <p className="truncate text-sm font-semibold text-text-primary">{group.name}</p>
                  <span className="shrink-0 text-xs text-text-muted">{group.items.length} listing{group.items.length === 1 ? "" : "s"}</span>
                </div>
                <div className="space-y-2">
                  {group.items.map((item, index) => (
                    <div
                      key={`${item.listing_id ?? item.fingerprint ?? index}`}
                      className="cursor-pointer transition-transform hover:-translate-y-0.5"
                      onClick={(event) => {
                        if (item.listing_id && !(event.target as HTMLElement).closest("button,a")) void inspectListing(item);
                      }}
                    >
                      <ListingCard item={item} compact onContactBroker={contactBroker} contacting={contacting} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ResizablePanel>

        <div className="order-first h-[38dvh] min-h-[280px] min-w-0 flex-none bg-[#dbeef2] lg:order-none lg:h-auto lg:flex-1">
          {loading ? <div className="flex h-full items-center justify-center text-sm text-text-muted">Loading market data…</div>
            : !googleMapsKey ? <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">Google Maps is not configured for this frontend yet.</div>
              : !isLoaded ? <div className="flex h-full items-center justify-center text-sm text-text-muted">Loading Google Maps…</div>
                : <GoogleMap
                  mapContainerStyle={containerStyle}
                  center={mumbaiCenter}
                  zoom={11}
                  onLoad={(map) => { mapRef.current = map; }}
                  onUnmount={() => { mapRef.current = null; }}
                  options={{ streetViewControl: false, mapTypeControl: false, fullscreenControl: true }}
                >
                  {activeGroups.filter((group) => group.position).map((group) => (
                    <Marker key={group.key} position={group.position!} icon={markerIcon(group.items[0])} onClick={() => focusGroup(group)} />
                  ))}
                  {selectedGroup?.position && (
                    <InfoWindow position={selectedGroup.position} onCloseClick={() => setSelectedKey("")}>
                      <div className="min-w-[210px] space-y-1 text-slate-900">
                        <div className="font-semibold">{selectedGroup.name}</div>
                        <div className="text-xs">{selectedGroup.locality || "Location not specified"}</div>
                        <div className="text-xs">{selectedGroup.items.length} listing{selectedGroup.items.length === 1 ? "" : "s"}</div>
                        {selectedGroup.items[0]?.listing_id && <button type="button" className="text-xs font-medium text-emerald-700 underline" onClick={() => void inspectListing(selectedGroup.items[0])}>Open listing</button>}
                      </div>
                    </InfoWindow>
                  )}
                </GoogleMap>}
        </div>
      </div>

      {selectedListing && (
        <ListingDetailDrawer
          item={selectedListing}
          detail={listingDetail}
          loading={detailLoading}
          contacting={contacting}
          onContact={() => selectedListing.listing_id && void contactBroker(selectedListing.listing_id)}
          onClose={() => { setSelectedListing(null); setListingDetail(null); }}
        />
      )}

      {!loading && searchActive && listings.length === 0 && <p className="text-sm text-text-muted">No listings match this search.</p>}
      {!loading && !searchActive && browseListings.length === 0 && <p className="text-sm text-text-muted">No live listings are available.</p>}
    </section>
  );
}

function DetailValue({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  const display = formatListingValue(value);
  return <div className="rounded-lg border border-border/70 bg-surface px-3 py-2"><dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">{label}</dt><dd className="mt-1 text-sm text-text-primary">{display}</dd></div>;
}

function ListingDetailDrawer({
  item,
  detail,
  loading,
  contacting,
  onContact,
  onClose,
}: {
  item: MarketListing;
  detail: Record<string, any> | null;
  loading: boolean;
  contacting: boolean;
  onContact: () => void;
  onClose: () => void;
}) {
  const data = { ...item, ...(detail || {}) };
  const detailPrice = formatDetailPrice(data);
  const fields: Array<[string, unknown]> = [
    ["Configuration", formatConfiguration(data.configuration_type, data.bhk)],
    ["Bathrooms", data.bathroom_count],
    ["Carpet area", data.carpet_area_sqft ? `${data.carpet_area_sqft} sqft` : null],
    ["Built-up area", data.built_up_area_sqft ? `${data.built_up_area_sqft} sqft` : null],
    ["Price as posted", detailPrice],
    ["Price basis", data.price_basis],
    ["Floor", data.floor_label || data.floor_range || data.floor],
    ["Parking", data.parking_details || data.parking_type || (data.car_parking_count ? `${data.car_parking_count} car` : null)],
    ["Furnishing", data.furnishing_status || data.furnishing],
    ["Deposit", data.deposit_raw_text || data.deposit_amount],
    ["Availability", data.availability_status || data.available_from],
    ["Lease term", data.lease_term_raw_text || data.lease_term_type],
    ["Building amenities", data.building_amenities],
    ["Unit amenities", data.unit_amenities],
    ["Tenant preference", data.tenant_type_preference],
    ["View", data.view_description || data.property_view],
    ["Developer", data.developer_name],
    ["Deal tags", data.deal_tags],
  ];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/45" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-background p-4 shadow-2xl sm:p-6" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent">Quick listing view</p>
            <h2 className="mt-1 text-xl font-semibold text-text-primary">{String(data.building_name || data.location_label || "Property listing")}</h2>
            <p className="mt-1 text-sm text-text-muted">{data.micro_market || data.location_label || data.building_address || "Location not specified"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close listing details" className="rounded-lg border border-border p-2 text-text-muted hover:text-text-primary"><X className="h-4 w-4" /></button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {detailPrice && <span className="rounded-full bg-accent/15 px-3 py-1.5 text-sm font-semibold text-accent">{detailPrice}</span>}
          {data.intent && <span className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-text-primary">{String(data.intent).toLowerCase()}</span>}
          {data.last_seen_text && <span className="text-xs text-text-muted">{data.last_seen_text}</span>}
        </div>

        <button type="button" onClick={onContact} disabled={contacting} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-background disabled:opacity-60">
          <MessageSquare className="h-4 w-4" /> {contacting ? "Opening WhatsApp…" : "Contact broker on WhatsApp"}
        </button>

        {loading && <p className="mt-6 text-sm text-text-muted">Loading extracted details…</p>}
        {!loading && <>
          <dl className="mt-6 grid grid-cols-2 gap-2">
            {fields.map(([label, value]) => <DetailValue key={label} label={label} value={value} />)}
          </dl>
          {(data.broker_display_name || data.broker_company || data.broker_name) && <div className="mt-6 rounded-xl border border-border bg-surface p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">Source broker</p><p className="mt-1 font-semibold text-text-primary">{data.broker_display_name || data.broker_company || data.broker_name}</p><p className="mt-1 text-xs text-text-muted">Sourced from the WhatsApp broker network</p></div>}
          {data.summary_title && <div className="mt-4 rounded-xl border border-border bg-surface p-4"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">Broker’s description</p><p className="mt-1 text-sm text-text-primary">{data.summary_title}</p></div>}
        </>}

        {data.listing_id && <Link href={`/listings/${data.listing_id}`} className="mt-5 inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Open full record <ArrowUpRight className="h-3.5 w-3.5" /></Link>}
      </aside>
    </div>
  );
}
