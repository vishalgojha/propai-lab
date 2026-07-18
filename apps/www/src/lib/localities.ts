import { getServerSupabase, slugify } from "./supabase";
import { getTitlesForRawMessageIds } from "./listing-titles";
import { canonicalLocality } from "./locality-canon";

export type BuildingOnMap = {
  name: string;
  id: number | null;
  latitude: number | null;
  longitude: number | null;
  listingCount: number;
  minPrice: number | null;
  maxPrice: number | null;
  priceUnit: string | null;
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
  rentCount: number;
  saleCount: number;
  priceRangeLabel: string | null;
  topBhk: string | null;
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
  price_unit: string | null;
  intent: string | null;
  asset_type: string | null;
  property_type: string | null;
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
    const name = (row.canonical_name ?? "").trim();
    // Skip broker/agency names mistakenly stored as buildings — they render
    // as cards that 404 on /buildings/<slug>.
    if (isJunkBuildingName(name)) continue;
    result.set(name.toLowerCase(), row);
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
      rentCount: 0,
      saleCount: 0,
      priceRangeLabel: null,
      topBhk: null,
    };
  }

  // Resolve slug back to a canonical locality. The stored micro_market
  // values are dirty (case dupes, non-place buckets, ambiguous parents), so we
  // run every raw value through the canonical map and match the requested slug
  // against the *canonical* slug. This merges "Bandra Bkc"/"Bandra BKC", hides
  // internal buckets, and applies confirmed implied-direction rules — without
  // needing a backfill first.
  // Paginate: capped at 1000 rows otherwise. Without this, low-volume
  // localities would fail to resolve their detail page.
  const PAGE = 1000;
  let marketRows: Array<{ micro_market: string | null }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: page } = await db
      .from("listings")
      .select("micro_market")
      .not("micro_market", "is", null)
      .range(offset, offset + PAGE - 1);
    marketRows = marketRows.concat((page ?? []) as typeof marketRows);
    if (!page || page.length < PAGE) break;
  }

  // canonical slug -> { label, public, standalonePage, rawValues }
  const byCanonical = new Map<
    string,
    { label: string; public: boolean; standalonePage: boolean; raw: Set<string> }
  >();
  for (const row of marketRows) {
    const raw = (row.micro_market ?? "").trim();
    if (!raw) continue;
    const c = canonicalLocality(raw);
    if (!c.public || !c.slug) continue;
    const existing = byCanonical.get(c.slug);
    if (existing) existing.raw.add(raw);
    else byCanonical.set(c.slug, { label: c.label, public: c.public, standalonePage: c.standalonePage, raw: new Set([raw]) });
  }

  const listingCanon = byCanonical.get(slug);

  // Paginate buildings (4k+ rows) — a bare select is capped at 1000 rows.
  let knownPlaces: Array<{ micro_market: string | null }> = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page } = await db
      .from("buildings")
      .select("micro_market")
      .not("micro_market", "is", null)
      .range(offset, offset + 999);
    knownPlaces = knownPlaces.concat((page ?? []) as typeof knownPlaces);
    if (!page || page.length < 1000) break;
  }

  const knownCanon = new Map<string, { label: string; standalonePage: boolean; raw: Set<string> }>();
  for (const row of knownPlaces) {
    const raw = (row.micro_market ?? "").trim();
    if (!raw) continue;
    const c = canonicalLocality(raw);
    if (!c.public || !c.slug) continue;
    const existing = knownCanon.get(c.slug);
    if (existing) existing.raw.add(raw);
    else knownCanon.set(c.slug, { label: c.label, standalonePage: c.standalonePage, raw: new Set([raw]) });
  }

  const placeCanon = knownCanon.get(slug);

  // True 404 case: not a known place at all (typo / garbage slug).
  if (!listingCanon && !placeCanon) return null;

  const canon = listingCanon ?? placeCanon!;

  // Generic parents (Andheri, Dadar, ...) are confirmed ambiguous — they get
  // NO standalone detail page (surfaced only via general search) to avoid
  // Bandra-BKC-style confusion. Return 404 for their slug.
  if (!canon.standalonePage) return null;

  // Known place, but zero active listings — distinct from a 404 typo.
  if (!listingCanon) {
    return {
      locality: canon.label,
      slug,
      buildings: [],
      mappedCount: 0,
      unmappedCount: 0,
      totalListings: 0,
      hasListings: false,
      rentCount: 0,
      saleCount: 0,
      priceRangeLabel: null,
      topBhk: null,
    };
  }

  const { data: listings, error } = await (async () => {
    // Paginate: a busy locality can have >1000 listings, and a bare select is
    // capped at 1000 rows. Query across every raw micro_market value that maps
    // to this canonical (e.g. "Bandra Bkc" + "Bandra BKC" both -> Bandra East).
    const rawValues = Array.from(listingCanon.raw);
    const PAGE = 1000;
    let collected: ListingRow[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from("listings")
        .select("building_name, bhk, price, price_unit, intent, asset_type, property_type, micro_market")
        .in("micro_market", rawValues)
        .range(offset, offset + PAGE - 1);
      if (error) return { data: null, error };
      collected = collected.concat((data ?? []) as ListingRow[]);
      if (!data || data.length < PAGE) break;
    }
    return { data: collected, error: null };
  })();

  if (error) {
    console.error("getLocalityData listings error:", error.message);
    return null;
  }

  const rows = (listings ?? []) as ListingRow[];

  // Derive a human-friendly price range + config mix for the locality
  // description and E-E-A-T trust block. Prices are stored in native units, so
  // we normalize everything to absolute INR. Source data is dirty (mixed unit
  // scales, null units, occasional garbage values), so we: (a) only trust rows
  // with a known unit, and (b) clamp to a Mumbai-plausible band, then take the
  // 2nd–98th percentile to avoid edge outliers in the displayed range.
  const priceToInr = (value: number | null, unit: string | null): number | null => {
    if (value == null) return null;
    const u = (unit || "").trim().toLowerCase();
    if (u === "cr" || u === "crore" || u === "crores") return value * 1_00_00_000;
    if (u === "l" || u === "lac" || u === "lakh" || u === "lakhs") return value * 1_00_000;
    if (u === "k" || u === "thousand") return value * 1_000;
    if (u === "abs" || u === "inr") return value;
    return null; // unknown / null unit — skip rather than guess
  };

  const inrLabel = (value: number): string => {
    if (value >= 1_00_00_000) {
      const cr = value / 1_00_00_000;
      return `₹${cr % 1 === 0 ? cr : cr.toFixed(1)} Cr`;
    }
    if (value >= 1_00_000) {
      const l = value / 1_00_000;
      return `₹${l % 1 === 0 ? l : l.toFixed(1)} L`;
    }
    return `₹${value.toLocaleString("en-IN")}`;
  };

  const PRICE_FLOOR = 5_00_000; // ₹5 L — below this is almost certainly dirty
  const PRICE_CEIL = 200_00_00_000; // ₹200 Cr — above this is almost certainly dirty

  let rentCount = 0;
  let saleCount = 0;
  const inrPrices: number[] = [];
  const bhkFreq = new Map<number, number>();
  for (const r of rows) {
    const i = (r.intent || "").toLowerCase();
    if (i === "rent" || i === "rental" || i === "lease") rentCount += 1;
    else if (i === "sale" || i === "sell" || i === "buy") saleCount += 1;
    const inr = priceToInr(r.price, r.price_unit);
    if (inr != null && inr >= PRICE_FLOOR && inr <= PRICE_CEIL) inrPrices.push(inr);
    for (const n of parseBhkValues(r.bhk)) bhkFreq.set(n, (bhkFreq.get(n) ?? 0) + 1);
  }
  let priceRangeLabel: string | null = null;
  if (inrPrices.length >= 2) {
    inrPrices.sort((a, b) => a - b);
    const loIdx = Math.min(inrPrices.length - 1, Math.floor(inrPrices.length * 0.02));
    const hiIdx = Math.max(0, Math.ceil(inrPrices.length * 0.98) - 1);
    priceRangeLabel = `${inrLabel(inrPrices[loIdx])}–${inrLabel(inrPrices[hiIdx])}`;
  } else if (inrPrices.length === 1) {
    priceRangeLabel = inrLabel(inrPrices[0]);
  }
  const topBhk =
    bhkFreq.size > 0
      ? `${[...bhkFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]} BHK`
      : null;


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
      priceUnits: string[];
      bhks: Set<number>;
      bhkRaw: Set<string>;
    }
  >();

  for (const row of rows) {
    const name = (row.building_name ?? "").trim();
    if (!name) continue;
    // Skip broker/agency names stored as building_name — they produce cards
    // that 404 on /buildings/<slug> (e.g. "OM Sai Real Estate").
    if (isJunkBuildingName(name)) continue;
    const entry = agg.get(name) ?? {
      name,
      count: 0,
      prices: [] as number[],
      priceUnits: [] as string[],
      bhks: new Set<number>(),
      bhkRaw: new Set<string>(),
    };
    entry.count += 1;
    if (typeof row.price === "number") entry.prices.push(row.price);
    if (row.price_unit) entry.priceUnits.push(String(row.price_unit));
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

    // Dominant price unit for this building's listings (price is stored in the
    // unit's native scale, e.g. 5.5 Cr, not absolute rupees).
    let priceUnit: string | null = null;
    if (entry.priceUnits.length) {
      const freq = new Map<string, number>();
      for (const u of entry.priceUnits) freq.set(u, (freq.get(u) ?? 0) + 1);
      priceUnit = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }

    buildings.push({
      name: entry.name,
      id: null,
      latitude,
      longitude,
      listingCount: entry.count,
      minPrice: entry.prices.length ? Math.min(...entry.prices) : null,
      maxPrice: entry.prices.length ? Math.max(...entry.prices) : null,
      priceUnit,
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
    locality: canon.label,
    slug,
    buildings,
    mappedCount,
    unmappedCount,
    totalListings: rows.length,
    hasListings: rows.length > 0,
    rentCount,
    saleCount,
    priceRangeLabel,
    topBhk,
  };
}

export async function getAllLocalities(): Promise<LocalitySummary[]> {
  const db = getServerSupabase();
  if (!db) return [];

  // Paginate: a bare select is capped at 1000 rows, which would drop
  // low-volume localities (e.g. Bandra East with a handful of listings) from
  // the locality list and search suggestions.
  const PAGE = 1000;
  let all: Array<{ micro_market: string | null }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("listings")
      .select("micro_market")
      .not("micro_market", "is", null)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("getAllLocalities error:", error.message);
      return [];
    }
    all = all.concat((data ?? []) as typeof all);
    if (!data || data.length < PAGE) break;
  }

  // Aggregate by canonical locality. Case dupes ("Bandra Bkc"/"Bandra BKC")
  // merge; hidden internal buckets drop; generic ambiguous parents (Andheri,
  // Dadar, ...) are excluded from the browse list (no standalone page) but
  // remain reachable via general search.
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of all) {
    const raw = (row.micro_market ?? "").trim();
    if (!raw) continue;
    const c = canonicalLocality(raw);
    if (!c.public || !c.standalonePage || !c.slug) continue;
    const existing = counts.get(c.slug);
    if (existing) existing.count += 1;
    else counts.set(c.slug, { label: c.label, count: 1 });
  }

  return Array.from(counts.entries())
    .map(([slug, { label, count }]) => ({
      locality: label,
      slug,
      listingCount: count,
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

export async function getAllBuildings(limit = 5000): Promise<BuildingSummary[]> {
  const db = getServerSupabase();
  if (!db) return [];

  // Paginate: buildings has ~4k rows, a bare select is capped at 1000.
  let buildings: Array<{
    id: number | null;
    canonical_name: string | null;
    micro_market: string | null;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    developer: string | null;
  }> = [];
  for (let offset = 0; ; offset += 1000) {
    const { data: page } = await db
      .from("buildings")
      .select("id, canonical_name, micro_market, latitude, longitude, address, developer")
      .not("canonical_name", "is", null)
      .order("canonical_name", { ascending: true })
      .range(offset, offset + 999);
    buildings = buildings.concat((page ?? []) as typeof buildings);
    if (!page || page.length < 1000) break;
    if (buildings.length >= limit) break;
  }

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

  return (buildings ?? [])
    .filter((b) => !isJunkBuildingName(b.canonical_name ?? ""))
    .map((b) => {
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
  asset_type: string | null;
  property_type: string | null;
  micro_market: string | null;
  view: string | null;
  floor_description: string | null;
  building_name: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  last_seen: string | null;
  title: string | null;
  representative_raw_message_id: number | null;
  latest_raw_message_id: number | null;
};

export type ListingDetail = BuildingListing & {
  area_sqft: number | null;
  landmark_name: string | null;
  location_label: string | null;
  buildingSlug: string | null;
  localitySlug: string | null;
};

// A real building name is short and Proper-noun-like. Ingestion sometimes
// stores an entire message as building_name (e.g. "Available Commercial Space
// For Rent at Near Pali Village..."), which then leaks into buildings.canonical_name
// and renders as a garbage /buildings/[slug] page. Reject those as 404s.
const JUNK_AD_PHRASES =
  /\b(available|commercial space|for rent|for sale|on rent|on sale|outright|unfurnished|furnished|furnish|semi furnished|car parking|carpet|built up|super area|sq\.? ?ft|sqft|bhk|rent|sale|possession|resale)\b/i;
const SOCIETY_WORDS =
  /\b(society|chs|chsl|co[- ]?op|cooperative|housing|apartment|apartments|niwas|park|phase|tower|towers|complex|heights|residency|building|estate|enclave|gardens|residences|layout)\b/i;
// Broker / agency names mistakenly stored as building_name. These should never
// render as a building card (clicking them 404s on /buildings/<slug>).
const BROKER_NAME_PHRASES =
  /\b(real estate|realtor|broker|broking|properties|property consultant|consultant|ventures|realty)\b/i;
const JUNK_LEADING = /^[.\*◇\-_📍🔥]+/;
// Pure ad/bhk/area fragments with no proper-noun building name, e.g.
// "1bhk", "2.5bhk", "1rk", "1850 carpet", "3.5 Bhk".
const PURE_FRAGMENT =
  /^\s*(?:[0-9]+(\.[0-9]+)?\s*(?:bhk|rk|bhk\+bhk|jodi)?\s*|[0-9,]+\s*(?:carpet|sqft|sq\.?\s*ft|sqm|area)?\s*|bhk\s*[\+/]?\s*bhk\s*)*$/i;

export function isJunkBuildingName(name: string | null): boolean {
  if (!name) return true;
  const n = name.trim();
  if (n.length < 3) return true;

  const lower = n.toLowerCase();
  // Pure BHK / area fragments are never buildings.
  if (PURE_FRAGMENT.test(n)) return true;
  // Broker / agency names are never buildings — exclude them outright, even
  // though some (e.g. "estate") overlap with legitimate society suffixes.
  if (BROKER_NAME_PHRASES.test(lower)) return true;
  // Legitimate building/society names are never junk.
  if (SOCIETY_WORDS.test(lower)) return false;

  const words = n.split(/\s+/).filter(Boolean);
  const hasAd = JUNK_AD_PHRASES.test(lower);
  // Reads like an ad sentence: an ad phrase present AND (many words, a leading
  // markdown/punctuation artifact, or just a short ad fragment like
  // "2bhk flat on rent" / "3bhk apt").
  if (hasAd && (words.length >= 3 || JUNK_LEADING.test(n))) return true;
  return false;
}

export async function getBuildingBySlug(rawSlug: string): Promise<BuildingDetail | null> {
  const db = getServerSupabase();
  const slug = slugify(rawSlug);
  if (!db || !slug) return null;

  // Paginate: Supabase caps a single select at 1000 rows, but buildings has
  // ~4k rows. Without paging we'd only ever scan the first page and miss
  // most buildings (causing false 404s).
  const PAGE = 1000;
  let all: Array<{
    canonical_name: string | null;
    micro_market: string | null;
    latitude: number | null;
    longitude: number | null;
    address: string | null;
    developer: string | null;
    enrichment_confidence: unknown;
    id: number | null;
  }> = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("buildings")
      .select("id, canonical_name, micro_market, latitude, longitude, address, developer, enrichment_confidence")
      .not("canonical_name", "is", null)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("getBuildingBySlug error:", error.message);
      return null;
    }
    all = all.concat((data ?? []) as typeof all);
    if (!data || data.length < PAGE) break;
  }

  const match = all.find((b) => slugify(b.canonical_name ?? "") === slug);
  if (!match) return null;

  // Reject junk names (raw message text leaked as a building) — render 404
  // instead of a garbage building page.
  if (isJunkBuildingName(match.canonical_name ?? "")) return null;

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

  // Filter at the DB layer (exact canonical name) and paginate past the 1000-row
  // cap so a building with >100 listings shows them all.
  const target = name.trim();
  const PAGE = 1000;
  let all: Array<{
    id: number;
    bhk: string | null;
    price: number | null;
    price_unit: string | null;
    furnishing: string | null;
    intent: string | null;
    asset_type: string | null;
    property_type: string | null;
    micro_market: string | null;
    view: string | null;
    floor_description: string | null;
    building_name: string | null;
    broker_name: string | null;
    broker_phone: string | null;
    last_seen: string | null;
    representative_raw_message_id: number | null;
    latest_raw_message_id: number | null;
  }> = [];

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("listings")
      .select(
        "id, bhk, price, price_unit, furnishing, intent, asset_type, property_type, micro_market, view, floor_description, building_name, broker_name, broker_phone, last_seen, representative_raw_message_id, latest_raw_message_id",
      )
      .eq("building_name", target)
      .order("last_seen", { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error("getBuildingListings error:", error.message);
      return [];
    }
    all = all.concat((data ?? []) as typeof all);
    if (!data || data.length < PAGE) break;
  }

  // Real titles are computed at ingestion time and stored on parsed_output,
  // keyed by the raw WhatsApp message — not on the listings row itself.
  const titleMap = await getTitlesForRawMessageIds(
    all.flatMap((r) => [r.representative_raw_message_id, r.latest_raw_message_id]),
  );

  return all.map((r) => ({
    id: r.id,
    bhk: r.bhk,
    price: r.price,
    price_unit: r.price_unit,
    furnishing: r.furnishing,
    intent: r.intent,
    asset_type: r.asset_type,
    property_type: r.property_type,
    micro_market: r.micro_market,
    view: r.view,
    floor_description: r.floor_description,
    building_name: r.building_name,
    broker_name: r.broker_name,
    broker_phone: r.broker_phone,
    last_seen: r.last_seen,
    representative_raw_message_id: r.representative_raw_message_id,
    latest_raw_message_id: r.latest_raw_message_id,
    title:
      (r.representative_raw_message_id != null ? titleMap.get(r.representative_raw_message_id) : null) ??
      (r.latest_raw_message_id != null ? titleMap.get(r.latest_raw_message_id) : null) ??
      null,
  }));
}

export async function getListingById(id: number): Promise<ListingDetail | null> {
  const db = getServerSupabase();
  if (!db || !Number.isFinite(id)) return null;

  const { data, error } = await db
    .from("listings")
    .select(
      "id, bhk, price, price_unit, area_sqft, furnishing, intent, asset_type, property_type, location_label, landmark_name, micro_market, view, floor_description, broker_name, broker_phone, last_seen, building_name, representative_raw_message_id, latest_raw_message_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error("getListingById error:", error.message);
    return null;
  }

  const titleMap = await getTitlesForRawMessageIds([
    data.representative_raw_message_id,
    data.latest_raw_message_id,
  ]);

  const title =
    (data.representative_raw_message_id != null ? titleMap.get(data.representative_raw_message_id) : null) ??
    (data.latest_raw_message_id != null ? titleMap.get(data.latest_raw_message_id) : null) ??
    null;

  return {
    id: data.id,
    bhk: data.bhk,
    price: data.price,
    price_unit: data.price_unit,
    area_sqft: data.area_sqft,
    furnishing: data.furnishing,
    intent: data.intent,
    asset_type: data.asset_type,
    property_type: data.property_type,
    micro_market: data.micro_market,
    view: data.view,
    floor_description: data.floor_description,
    building_name: data.building_name,
    landmark_name: data.landmark_name,
    location_label: data.location_label,
    broker_name: data.broker_name,
    broker_phone: data.broker_phone,
    last_seen: data.last_seen,
    title,
    representative_raw_message_id: data.representative_raw_message_id,
    latest_raw_message_id: data.latest_raw_message_id,
    buildingSlug:
      data.building_name && !isJunkBuildingName(data.building_name) ? slugify(data.building_name) : null,
    localitySlug: data.micro_market ? slugify(data.micro_market) : null,
  };
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
