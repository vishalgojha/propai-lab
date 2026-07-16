import { getServerSupabase, slugify } from "./supabase";

export type BuildingOnMap = {
  name: string;
  id: number | null;
  latitude: number | null;
  longitude: number | null;
  listingCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  bhkRange: string | null;
  address: string | null;
  developer: string | null;
};

export type LocalityData = {
  locality: string;
  slug: string;
  buildings: BuildingOnMap[];
  mappedCount: number;
  unmappedCount: number;
  totalListings: number;
  hasListings: boolean;
};

export type LocalitySummary = {
  locality: string;
  slug: string;
  listingCount: number;
};

type ListingRow = {
  building_name: string | null;
  bhk: string | null;
  price: number | null;
  intent: string | null;
  micro_market: string | null;
};

type BuildingRow = {
  canonical_name: string;
  latitude: number | null;
  longitude: number | null;
};

function bhkLabel(bhk: string | null): string {
  if (!bhk) return "";
  return bhk.trim();
}

function parseBhkValues(bhk: string | null): number[] {
  if (!bhk) return [];
  const matches = bhk.match(/\d+/g);
  if (!matches) return [];
  return matches.map(Number).filter((n) => n > 0 && n < 20);
}

async function fetchBuildingsForNames(
  names: string[],
): Promise<Map<string, BuildingRow>> {
  const db = getServerSupabase();
  const result = new Map<string, BuildingRow>();
  if (!db || names.length === 0) return result;

  // buildings.canonical_name matches are case-sensitive in Postgres, so we
  // must query with the ORIGINAL casing and only normalize for the in-memory
  // lookup map. Keep a lowercase -> original-cased index for that.
  const originals = Array.from(
    new Set(names.map((n) => n.trim()).filter(Boolean)),
  );
  if (originals.length === 0) return result;

  const lowerToOriginal = new Map<string, string>();
  for (const n of originals) lowerToOriginal.set(n.toLowerCase(), n);

  // 1) direct canonical_name match (original casing)
  const { data: direct } = await db
    .from("buildings")
    .select("canonical_name, latitude, longitude")
    .in("canonical_name", originals);

  for (const row of direct ?? []) {
    result.set((row.canonical_name ?? "").trim().toLowerCase(), row);
  }

  // 2) fallback via building_name_aliases
  const matchedLower = new Set(result.keys());
  const remaining = originals.filter(
    (n) => !matchedLower.has(n.toLowerCase()),
  );
  if (remaining.length > 0) {
    const { data: aliases } = await db
      .from("building_name_aliases")
      .select("alias, canonical_name")
      .in("alias", remaining);

    const byCanonical = new Map<string, string>();
    for (const a of aliases ?? []) {
      const canon = (a.canonical_name ?? "").trim();
      const alias = (a.alias ?? "").trim();
      if (canon && alias) byCanonical.set(canon, alias);
    }

    if (byCanonical.size > 0) {
      const { data: aliasBuildings } = await db
        .from("buildings")
        .select("canonical_name, latitude, longitude")
        .in("canonical_name", Array.from(byCanonical.keys()));

      for (const row of aliasBuildings ?? []) {
        const key = (row.canonical_name ?? "").trim().toLowerCase();
        result.set(key, row);
        const aliasOriginal = byCanonical.get(row.canonical_name ?? "");
        if (aliasOriginal) {
          result.set(aliasOriginal.toLowerCase(), row);
        }
      }
    }
  }

  return result;
}

export async function getLocalityData(rawSlug: string): Promise<LocalityData | null> {
  const db = getServerSupabase();
  const slug = slugify(rawSlug);
  if (!db) {
    return {
      locality: rawSlug,
      slug,
      buildings: [],
      mappedCount: 0,
      unmappedCount: 0,
      totalListings: 0,
      hasListings: false,
    };
  }

  // Resolve slug back to an actual micro_market value (slug is lossy).
  // We check two sources: listings (active inventory) and buildings
  // (known places we track, even if no listings yet). A slug that matches a
  // known place but has zero listings is a distinct case from a typo/garbage
  // slug — the page surfaces "no listings yet" rather than a bare 404.
  const { data: markets } = await db
    .from("listings")
    .select("micro_market")
    .not("micro_market", "is", null);

  const distinctMarkets = Array.from(
    new Set((markets ?? []).map((m) => (m.micro_market ?? "").trim()).filter(Boolean)),
  );

  const listingMatch = distinctMarkets.find((m) => slugify(m) === slug);

  const { data: knownPlaces } = await db
    .from("buildings")
    .select("micro_market")
    .not("micro_market", "is", null);

  const knownMarkets = Array.from(
    new Set((knownPlaces ?? []).map((b) => (b.micro_market ?? "").trim()).filter(Boolean)),
  );

  const placeMatch = knownMarkets.find((m) => slugify(m) === slug);

  // True 404 case: not a known place at all (typo / garbage slug).
  if (!listingMatch && !placeMatch) return null;

  const match = listingMatch ?? placeMatch!;

  // Known place, but zero active listings — distinct from a 404 typo.
  if (!listingMatch) {
    return {
      locality: match,
      slug,
      buildings: [],
      mappedCount: 0,
      unmappedCount: 0,
      totalListings: 0,
      hasListings: false,
    };
  }

  const { data: listings, error } = await db
    .from("listings")
    .select("building_name, bhk, price, intent, micro_market")
    .eq("micro_market", match);

  if (error) {
    console.error("getLocalityData listings error:", error.message);
    return null;
  }

  const rows = (listings ?? []) as ListingRow[];

  const buildingNames = Array.from(
    new Set(rows.map((r) => r.building_name?.trim()).filter(Boolean) as string[]),
  );

  const buildingMap = await fetchBuildingsForNames(buildingNames);

  // Aggregate per building name.
  const agg = new Map<
    string,
    {
      name: string;
      count: number;
      prices: number[];
      bhks: Set<number>;
      bhkRaw: Set<string>;
    }
  >();

  for (const row of rows) {
    const name = (row.building_name ?? "").trim();
    if (!name) continue;
    const entry = agg.get(name) ?? {
      name,
      count: 0,
      prices: [],
      bhks: new Set<number>(),
      bhkRaw: new Set<string>(),
    };
    entry.count += 1;
    if (typeof row.price === "number") entry.prices.push(row.price);
    const parsed = parseBhkValues(row.bhk);
    if (parsed.length) parsed.forEach((n) => entry.bhks.add(n));
    const lbl = bhkLabel(row.bhk);
    if (lbl) entry.bhkRaw.add(lbl);
    agg.set(name, entry);
  }

  const buildings: BuildingOnMap[] = [];
  let mappedCount = 0;
  let unmappedCount = 0;

  for (const entry of agg.values()) {
    const key = entry.name.toLowerCase();
    const geo = buildingMap.get(key);
    const latitude = geo?.latitude ?? null;
    const longitude = geo?.longitude ?? null;

    let bhkRange: string | null = null;
    if (entry.bhks.size > 0) {
      const sorted = Array.from(entry.bhks).sort((a, b) => a - b);
      bhkRange =
        sorted.length === 1
          ? `${sorted[0]} BHK`
          : `${sorted[0]}-${sorted[sorted.length - 1]} BHK`;
    } else if (entry.bhkRaw.size > 0) {
      bhkRange = Array.from(entry.bhkRaw).join(", ");
    }

    if (latitude != null && longitude != null) mappedCount += 1;
    else unmappedCount += 1;

    buildings.push({
      name: entry.name,
      id: null,
      latitude,
      longitude,
      listingCount: entry.count,
      minPrice: entry.prices.length ? Math.min(...entry.prices) : null,
      maxPrice: entry.prices.length ? Math.max(...entry.prices) : null,
      bhkRange,
      address: null,
      developer: null,
    });
  }

  // Sort: mapped first, then by listing count desc.
  buildings.sort((a, b) => {
    const aMapped = a.latitude != null && a.longitude != null ? 0 : 1;
    const bMapped = b.latitude != null && b.longitude != null ? 0 : 1;
    if (aMapped !== bMapped) return aMapped - bMapped;
    return b.listingCount - a.listingCount;
  });

  return {
    locality: match,
    slug,
    buildings,
    mappedCount,
    unmappedCount,
    totalListings: rows.length,
    hasListings: rows.length > 0,
  };
}

export async function getAllLocalities(): Promise<LocalitySummary[]> {
  const db = getServerSupabase();
  if (!db) return [];

  const { data, error } = await db
    .from("listings")
    .select("micro_market")
    .not("micro_market", "is", null);

  if (error) {
    console.error("getAllLocalities error:", error.message);
    return [];
  }

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const m = (row.micro_market ?? "").trim();
    if (!m) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([locality, listingCount]) => ({
      locality,
      slug: slugify(locality),
      listingCount,
    }))
    .sort((a, b) => b.listingCount - a.listingCount);
}

export type BuildingSummary = {
  name: string;
  id: number | null;
  microMarket: string | null;
  listingCount: number;
  geocoded: boolean;
  address: string | null;
  developer: string | null;
};

export async function getAllBuildings(limit = 200): Promise<BuildingSummary[]> {
  const db = getServerSupabase();
  if (!db) return [];

  const { data: buildings } = await db
    .from("buildings")
    .select("id, canonical_name, micro_market, latitude, longitude, address, developer")
    .not("canonical_name", "is", null)
    .order("canonical_name", { ascending: true })
    .limit(limit);

  const { data: listings } = await db
    .from("listings")
    .select("building_name")
    .not("building_name", "is", null);

  const counts = new Map<string, number>();
  for (const row of listings ?? []) {
    const name = (row.building_name ?? "").trim().toLowerCase();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  return (buildings ?? []).map((b) => {
    const name = (b.canonical_name ?? "").trim();
    const geocoded = b.latitude != null && b.longitude != null;
    return {
      name,
      id: b.id ?? null,
      microMarket: (b.micro_market ?? "").trim() || null,
      listingCount: counts.get(name.toLowerCase()) ?? 0,
      geocoded,
      address: (b.address ?? "").trim() || null,
      developer: (b.developer ?? "").trim() || null,
    };
  });
}

export type BuildingDetail = {
  id: number | null;
  name: string;
  slug: string;
  microMarket: string | null;
  address: string | null;
  developer: string | null;
  geocoded: boolean;
  enrichmentConfidence: number | null;
};

export type BuildingListing = {
  id: number;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  furnishing: string | null;
  intent: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  last_seen: string | null;
};

export async function getBuildingBySlug(rawSlug: string): Promise<BuildingDetail | null> {
  const db = getServerSupabase();
  const slug = slugify(rawSlug);
  if (!db || !slug) return null;

  const { data, error } = await db
    .from("buildings")
    .select("id, canonical_name, micro_market, latitude, longitude, address, developer, enrichment_confidence")
    .not("canonical_name", "is", null);

  if (error) {
    console.error("getBuildingBySlug error:", error.message);
    return null;
  }

  const match = (data ?? []).find((b) => slugify(b.canonical_name ?? "") === slug);
  if (!match) return null;

  return {
    id: match.id ?? null,
    name: (match.canonical_name ?? "").trim(),
    slug,
    microMarket: (match.micro_market ?? "").trim() || null,
    address: (match.address ?? "").trim() || null,
    developer: (match.developer ?? "").trim() || null,
    geocoded: match.latitude != null && match.longitude != null,
    enrichmentConfidence:
      typeof match.enrichment_confidence === "number" ? match.enrichment_confidence : null,
  };
}

export async function getBuildingListings(name: string): Promise<BuildingListing[]> {
  const db = getServerSupabase();
  if (!db || !name.trim()) return [];

  const { data, error } = await db
    .from("listings")
    .select("id, bhk, price, price_unit, furnishing, intent, broker_name, broker_phone, last_seen, building_name")
    .order("last_seen", { ascending: false })
    .limit(100);

  if (error) {
    console.error("getBuildingListings error:", error.message);
    return [];
  }

  const target = name.trim().toLowerCase();
  return (data ?? [])
    .filter((r) => (r.building_name ?? "").trim().toLowerCase() === target)
    .map((r) => ({
      id: r.id,
      bhk: r.bhk,
      price: r.price,
      price_unit: r.price_unit,
      furnishing: r.furnishing,
      intent: r.intent,
      broker_name: r.broker_name,
      broker_phone: r.broker_phone,
      last_seen: r.last_seen,
    }));
}

export async function matchLocalities(
  query: string,
  limit = 5,
): Promise<LocalitySummary[]> {
  const all = await getAllLocalities();
  const q = slugify(query);
  if (!q) return all.slice(0, limit);

  const scored = all.map((loc) => {
    const locSlug = loc.slug;
    let score = 0;
    if (locSlug === q) score = 100;
    else if (locSlug.startsWith(q)) score = 70;
    else if (locSlug.includes(q)) score = 40;
    else if (q.includes(locSlug) && locSlug.length >= 3) score = 20;
    return { loc, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.loc.listingCount - a.loc.listingCount)
    .slice(0, limit)
    .map((s) => s.loc);
}
