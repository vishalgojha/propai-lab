import { getServerSupabase, slugify } from "./supabase";
import { unstable_cache } from "next/cache";
import { getTitlesForRawMessageIds } from "./listing-titles";
import { canonicalLocality, localityQueryLabels } from "./locality-canon";
import { buildListingSlug, dedupeRecentListings, normalizeBhkFromEvidence, type ListingCardFields } from "./listing-card";

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
  locality_raw?: string | null;
  locality_resolved?: string | null;
};

type BuildingRow = {
  id: number;
  canonical_name: string;
  latitude: number | null;
  longitude: number | null;
};

function localityTextFilter(rawSlug: string, fields = ["micro_market", "locality_resolved", "locality_raw"]): string {
  return localityQueryLabels(rawSlug)
    .flatMap((label) => fields.map((field) => `${field}.ilike.${label}`))
    .join(",");
}

function bhkLabel(bhk: string | null): string {
  if (!bhk) return "";
  return bhk.trim();
}

// Broker messages vary in casing and whitespace. This key is only for
// presentation aggregation; it never rewrites the raw evidence or merges
// distinct unit listings.
function buildingGroupKey(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function parseBhkValues(bhk: string | number | null): number[] {
  if (!bhk) return [];
  const matches = String(bhk).match(/\d+/g);
  if (!matches) return [];
  return matches.map(Number).filter((n) => n > 0 && n < 20);
}

async function fetchBuildingsForNames(
  names: string[],
): Promise<Map<string, BuildingRow>> {
  const db = getServerSupabase();
  const result = new Map<string, BuildingRow>();
  if (!db || names.length === 0) return result;

  // Postgres text equality is case-sensitive. Use case-insensitive exact
  // lookups here; the registry identity, not broker casing, is authoritative.
  const originals = Array.from(
    new Set(names.map((n) => n.trim()).filter(Boolean)),
  );
  if (originals.length === 0) return result;

  const exactRows = await Promise.all(originals.map(async (name) => {
    const { data } = await db
      .from("buildings")
      .select("id, canonical_name, latitude, longitude")
      .ilike("canonical_name", name)
      .limit(1);
    return { name, row: (data?.[0] ?? null) as BuildingRow | null };
  }));
  for (const { name, row } of exactRows) {
    if (row && row.canonical_name && !isJunkBuildingName(row.canonical_name)) {
      result.set(buildingGroupKey(name), row);
      result.set(buildingGroupKey(row.canonical_name), row);
    }
  }

  const remaining = originals.filter((name) => !result.has(buildingGroupKey(name)));
  const aliasRows = await Promise.all(remaining.map(async (name) => {
    const { data } = await db
      .from("building_name_aliases")
      .select("alias, canonical_name")
      .ilike("alias", name)
      .limit(1);
    return { name, alias: data?.[0] ?? null };
  }));
  for (const { name, alias } of aliasRows) {
    const canonical = String(alias?.canonical_name ?? "").trim();
    if (!canonical) continue;
    const { data } = await db
      .from("buildings")
      .select("id, canonical_name, latitude, longitude")
      .ilike("canonical_name", canonical)
      .limit(1);
    const row = (data?.[0] ?? null) as BuildingRow | null;
    if (row && !isJunkBuildingName(row.canonical_name ?? "")) {
      result.set(buildingGroupKey(name), row);
      result.set(buildingGroupKey(row.canonical_name), row);
    }
  }

  return result;
}

export async function getLocalityData(rawSlug: string): Promise<LocalityData | null> {
  const db = getServerSupabase();
  // Honour canonical redirects (e.g. "bkc" -> "bandra-kurla-complex")
  // before resolving raw micro_market values, so short aliases resolve.
  const canonSlug = canonicalLocality(rawSlug).slug || slugify(rawSlug);
  const slug = canonSlug;
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
      topBhk: null,
    };
  }

  // Resolve the canonical locality metadata from the slug.
  // The pre-computed canonical_micro_market_slug column means we no longer
  // need to paginate all 82k+ listings to build an in-memory canonical map.
  const canon = canonicalLocality(rawSlug);

  // True 404 case: not a known public place (typo / garbage slug).
  if (!canon.public || !canon.slug) return null;

  // Generic parents (Andheri, Dadar, ...) are confirmed ambiguous — they get
  // NO standalone detail page (surfaced only via general search) to avoid
  // Bandra-BKC-style confusion. Return 404 for their slug.
  if (!canon.standalonePage) return null;

  // Paginate listings filtered by canonical_micro_market_slug (indexed).
  // Use the server-side RPC to aggregate building summaries + stats in one
  // query, avoiding pagination of 10k+ rows into JS memory.
  // Try the RPC first (fast, single query). If it fails (timeout, permission,
  // network), fall back to direct Supabase queries so the page doesn't 404.
  let rpc: {
    buildings: Array<{
      name: string;
      listing_count: number;
      min_price: number | null;
      max_price: number | null;
      price_unit: string | null;
      bhk_raw: string | null;
    }>;
    total_count: number;
    rent_count: number;
    sale_count: number;
    top_bhk: string | null;
  } | null = null;

  try {
    const { data: rpcResult, error: rpcError } = await db.rpc("get_locality_summary", { p_slug: slug });
    if (
      !rpcError &&
      rpcResult &&
      Number((rpcResult as { total_count?: number }).total_count ?? 0) > 0 &&
      localityQueryLabels(slug).length === 1
    ) {
      rpc = rpcResult as typeof rpc;
    } else {
      console.error("getLocalityData RPC error:", rpcError?.message);
    }
  } catch (e) {
    console.error("getLocalityData RPC exception:", e);
  }

  // Fallback: if the RPC failed, do a direct query.
  if (!rpc) {
    let rows: ListingRow[] | null = null;
    let fallbackQuerySucceeded = false;
    try {
      // Use range to avoid pulling 18K+ rows in one shot — Supabase caps
      // an unpaginated select at 1000 rows, but for the summary we only
      // need the first page to get building names + stats. For accurate
      // total_count we fall back to a COUNT query below.
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const PAGE = 1000;
      const collected: ListingRow[] = [];
      let queryFailed = false;
      for (let offset = 0; ; offset += PAGE) {
        const { data: page, error: qErr } = await db
          .from("listings_unified")
          .select("building_name, bhk, price, price_unit, intent")
          .or(localityTextFilter(slug))
          .gte("last_seen", thirtyDaysAgo)
          .eq("needs_review", false)
          .range(offset, offset + PAGE - 1);
        if (qErr) {
          console.error("getLocalityData fallback query error:", qErr.message);
          queryFailed = true;
          break;
        }
        if (page) collected.push(...(page as ListingRow[]));
        if (!page || page.length < PAGE) break;
      }
      // An empty result is a valid answer for a known locality. Keep it
      // distinct from a query failure so the page can use the buildings table
      // to decide whether this is a known-but-empty locality.
      fallbackQuerySucceeded = !queryFailed;
      rows = collected;
    } catch (e) {
      console.error("getLocalityData fallback query exception:", e);
    }

    // If we couldn't even fetch a single page, try a COUNT as last resort.
    // This tells us the place IS populated — we just can't fetch details.
    if (!fallbackQuerySucceeded || !rows) {
      try {
        const { count } = await db
          .from("listings_unified")
          .select("id", { count: "exact", head: true })
          .or(localityTextFilter(slug))
          .eq("needs_review", false);
        if (count && count > 0) {
          // Return a degraded result — page renders with total count but
          // no building breakdown. Better than a hard 404.
          return {
            locality: canon.label,
            slug,
            buildings: [],
            mappedCount: 0,
            unmappedCount: 0,
            totalListings: count,
            hasListings: true,
            rentCount: 0,
            saleCount: 0,
            topBhk: null,
          };
        }
      } catch (e) {
        console.error("getLocalityData count fallback exception:", e);
      }
      return null;
    }

    // Aggregate in JS — same logic as the SQL RPC.
    const buildingMap = new Map<string, { name: string; listing_count: number; min_price: number | null; max_price: number | null; price_unit: string | null; bhkSet: Set<string> }>();
    let rentCount = 0;
    let saleCount = 0;
    const bhkNumCounts = new Map<string, number>();

    for (const row of rows) {
      const intent = (row.intent || "").toLowerCase();
      if (intent === "rent" || intent === "rental" || intent === "lease") rentCount++;
      else if (intent === "sale" || intent === "sell" || intent === "buy") saleCount++;

      const bhkMatch = (row.bhk || "").match(/\d+/);
      if (bhkMatch) {
        const n = bhkMatch[0];
        bhkNumCounts.set(n, (bhkNumCounts.get(n) || 0) + 1);
      }

      const bName = (row.building_name || "").trim();
      if (!bName) continue;
      const existing = buildingMap.get(buildingGroupKey(bName));
      if (existing) {
        existing.listing_count++;
        if (row.price != null) {
          if (existing.min_price == null || row.price < existing.min_price) existing.min_price = row.price;
          if (existing.max_price == null || row.price > existing.max_price) existing.max_price = row.price;
        }
        if (row.bhk) existing.bhkSet.add(row.bhk);
      } else {
        buildingMap.set(buildingGroupKey(bName), {
          name: bName,
          listing_count: 1,
          min_price: row.price ?? null,
          max_price: row.price ?? null,
          price_unit: row.price_unit ?? null,
          bhkSet: row.bhk ? new Set([row.bhk]) : new Set(),
        });
      }
    }

    let topBhk: string | null = null;
    let topCount = 0;
    for (const [num, cnt] of bhkNumCounts) {
      if (cnt > topCount) { topCount = cnt; topBhk = `${num} BHK`; }
    }

    rpc = {
      buildings: Array.from(buildingMap.values()).map((v) => ({
        name: v.name,
        listing_count: v.listing_count,
        min_price: v.min_price,
        max_price: v.max_price,
        price_unit: v.price_unit,
        bhk_raw: Array.from(v.bhkSet).join(", "),
      })).sort((a, b) => b.listing_count - a.listing_count),
      total_count: rows.length,
      rent_count: rentCount,
      sale_count: saleCount,
      top_bhk: topBhk,
    };
  }

  // Known place, but zero active listings — distinct from a 404 typo.
  // Check buildings table (small, ~4k rows) to confirm the place exists.
  if (rpc.total_count === 0) {
    const { count } = await db
      .from("buildings")
      .select("id", { count: "exact", head: true })
      .or(localityTextFilter(slug, ["micro_market"]));
    if (!count || count === 0) return null;
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
      topBhk: null,
    };
  }

  // Filter junk building names (broker names, ad fragments, etc.)
  // and locality-as-building-name entries using the same filter as JS.
  const rpcBuildings = rpc.buildings.filter(
    (b) => !isJunkBuildingName(b.name) && canonicalLocality(b.name).slug !== slug,
  );

  // Fetch geo data for the filtered building names.
  const buildingNames = rpcBuildings.map((b) => b.name);
  const buildingMap = await fetchBuildingsForNames(buildingNames);

  const buildings: BuildingOnMap[] = [];
  let mappedCount = 0;
  let unmappedCount = 0;

  for (const entry of rpcBuildings) {
    const key = buildingGroupKey(entry.name);
    const geo = buildingMap.get(key);
    const latitude = geo?.latitude ?? null;
    const longitude = geo?.longitude ?? null;

    // Parse BHK range from the SQL-aggregated bhk_raw string.
    let bhkRange: string | null = null;
    if (entry.bhk_raw) {
      const parts = entry.bhk_raw.split(",").map((s) => s.trim()).filter(Boolean);
      const nums = parts.map((p) => parseInt(p, 10)).filter((n) => !isNaN(n) && n > 0);
      if (nums.length > 0) {
        nums.sort((a, b) => a - b);
        bhkRange = nums.length === 1 ? `${nums[0]} BHK` : `${nums[0]}-${nums[nums.length - 1]} BHK`;
      } else {
        bhkRange = entry.bhk_raw;
      }
    }

    if (latitude != null && longitude != null) mappedCount += 1;
    else unmappedCount += 1;

    buildings.push({
      // Registry casing wins when the raw broker spelling resolves to a
      // canonical building. The grouping key remains presentation-only and
      // never changes the underlying listing evidence.
      name: geo?.canonical_name?.trim() || entry.name,
      id: geo?.id ?? null,
      latitude,
      longitude,
      listingCount: entry.listing_count,
      minPrice: entry.min_price,
      maxPrice: entry.max_price,
      priceUnit: entry.price_unit,
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
    totalListings: rpc.total_count,
    hasListings: rpc.total_count > 0,
    rentCount: rpc.rent_count,
    saleCount: rpc.sale_count,
    topBhk: rpc.top_bhk,
  };
}

// Resolve a locality slug to canonical metadata.
// Reused by getLocalityListings and the programmatic sub-pages
// (sale / rent / bhk / budget / commercial) so every filtered view
// resolves the same canonical metadata.
async function resolveLocalityRawValues(
  slug: string,
): Promise<{ label: string; standalonePage: boolean; raw: string[] } | null> {
  const canon = canonicalLocality(slug);
  if (!canon.public || !canon.slug) return null;
  if (!canon.standalonePage) return null;
  // raw is no longer needed for querying — we use canonical_micro_market_slug.
  // Return the label and standalonePage; callers query by slug directly.
  return { label: canon.label, standalonePage: canon.standalonePage, raw: [] };
}

export type LocalityListingFilter = {
  txn?: "sale" | "rent";
  bhk?: number;
  commercial?: boolean;
  budgetMaxCr?: number;
};

// Fetch the actual listing rows for a locality so programmatic sub-pages can
// render filtered cards + accurate counts. Queries by pre-computed
// canonical_micro_market_slug instead of scanning all rows.
export async function getLocalityListings(
  rawSlug: string,
  filter?: LocalityListingFilter,
): Promise<{ locality: string; slug: string; rows: ListingCardFields[] } | null> {
  const db = getServerSupabase();
  const canonSlug = canonicalLocality(rawSlug).slug || slugify(rawSlug);
  const slug = canonSlug;
  const canon = await resolveLocalityRawValues(slug);
  if (!canon) return null;
  if (!db) return { locality: canon.label, slug, rows: [] };

  const PAGE = 1000;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const collected: ListingCardFields[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("listings_unified")
      .select(
        "id, bhk, price, price_unit, price_model, price_per_sqft, area_sqft, furnishing, intent, asset_type, property_type, micro_market, locality_raw, locality_resolved, building_name, landmark_name, location_label, floor_description, view, representative_raw_message_id, latest_raw_message_id, broker_name, broker_phone, last_seen",
      )
      .or(localityTextFilter(slug))
      .gte("last_seen", thirtyDaysAgo)
      .eq("needs_review", false)
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("getLocalityListings error:", error.message);
      return null;
    }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      const rows2 = r as unknown as ListingCardFields;
      collected.push(rows2);
    }
    if (!data || data.length < PAGE) break;
  }

  // Apply server-side filters.
  let filtered = collected;
  if (filter?.txn) {
    filtered = filtered.filter((r) => {
      const i = (r.intent || "").toLowerCase();
      return filter.txn === "rent"
        ? i === "rent" || i === "rental" || i === "lease"
        : i === "sale" || i === "sell" || i === "buy";
    });
  }
  if (typeof filter?.bhk === "number") {
    filtered = filtered.filter((r) => parseBhkValues(r.bhk).includes(filter.bhk as number));
  }
  if (filter?.commercial) {
    filtered = filtered.filter((r) => (r.asset_type || "").toLowerCase() === "commercial");
  }
  if (typeof filter?.budgetMaxCr === "number") {
    const maxAbs = filter.budgetMaxCr * 1_00_00_000;
    filtered = filtered.filter((r) => {
      if (typeof r.price !== "number") return false;
      const u = (r.price_unit || "").toLowerCase();
      const abs = u.includes("cr")
        ? r.price > 1000
          ? r.price
          : r.price * 1_00_00_000
        : u.includes("lac")
          ? r.price * 1_00_000
          : u.includes("k")
            ? r.price * 1_000
            : r.price;
      return abs <= maxAbs;
    });
  }

  // Attach titles (regex/LLM-derived) where available.
  const titleMap = await getTitlesForRawMessageIds(
    filtered.flatMap((r) => [r.representative_raw_message_id, r.latest_raw_message_id]),
  );
  const rows: ListingCardFields[] = filtered.map((r) => ({
    ...r,
    title:
      (r.representative_raw_message_id != null ? titleMap.get(r.representative_raw_message_id) : null) ??
      (r.latest_raw_message_id != null ? titleMap.get(r.latest_raw_message_id) : null) ??
      null,
  }));

  return { locality: canon.label, slug, rows };
}

async function fetchAllLocalities(): Promise<LocalitySummary[]> {
  const db = getServerSupabase();
  if (!db) return [];

  // Use RPC for server-side aggregation instead of fetching all 96K+ rows.
  const { data: rpcData, error: rpcError } = await db.rpc("get_locality_counts");
  if (!rpcError && rpcData) {
    const counts = new Map<string, { label: string; count: number }>();
    for (const row of rpcData as Array<{ micro_market: string; listing_count: number }>) {
      const raw = (row.micro_market ?? "").trim();
      if (!raw) continue;
      const c = canonicalLocality(raw);
      if (!c.public || !c.standalonePage || !c.slug) continue;
      const existing = counts.get(c.slug);
      if (existing) existing.count += Number(row.listing_count);
      else counts.set(c.slug, { label: c.label, count: Number(row.listing_count) });
    }
    return Array.from(counts.entries())
      .map(([slug, { label, count }]) => ({ locality: label, slug, listingCount: count }))
      .sort((a, b) => b.listingCount - a.listingCount);
  }

  // Fallback: read recent raw locality labels directly. This is intentionally
  // bounded: the RPC is the fast path, but a public-role/RPC permission issue
  // must not turn the entire locality directory into an empty state.
  console.error("fetchAllLocalities RPC error:", rpcError?.message);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: recentRows, error: recentError } = await db
      .from("listings_unified")
      .select("micro_market")
      .not("micro_market", "is", null)
      .gte("last_seen", thirtyDaysAgo)
      .order("last_seen", { ascending: false })
      .limit(10_000);
  if (recentError) {
    console.error("fetchAllLocalities fallback error:", recentError.message);
    return [];
  }

  const slugToLabel = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const row of recentRows ?? []) {
    const c = canonicalLocality(String(row.micro_market ?? "").trim());
    if (!c.public || !c.standalonePage || !c.slug) continue;
    if (!slugToLabel.has(c.slug)) slugToLabel.set(c.slug, c.label);
    counts.set(c.slug, (counts.get(c.slug) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([slug, count]) => ({
      locality: slugToLabel.get(slug) ?? slug,
      slug,
      listingCount: count,
    }))
    .sort((a, b) => b.listingCount - a.listingCount);
}

export const getAllLocalities = unstable_cache(
  fetchAllLocalities,
  ["public-localities"],
  { revalidate: 300 },
);

export type BuildingSummary = {
  name: string;
  id: number | null;
  microMarket: string | null;
  listingCount: number;
  geocoded: boolean;
  address: string | null;
  developer: string | null;
};

async function fetchAllBuildings(limit = 5000): Promise<BuildingSummary[]> {
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

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: listings } = await db
    .from("listings_unified")
    .select("building_name, canonical_micro_market_slug")
    .not("building_name", "is", null)
    .gte("last_seen", thirtyDaysAgo)
    .eq("needs_review", false);

  const counts = new Map<string, number>();
  for (const row of listings ?? []) {
    const name = (row.building_name ?? "").trim().toLowerCase();
    if (!name) continue;
    const locality = String(row.canonical_micro_market_slug ?? "").trim().toLowerCase();
    const key = `${buildingGroupKey(name)}|${locality}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
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
        listingCount: counts.get(`${name.toLowerCase()}|${canonicalLocality(b.micro_market).slug}`) ?? 0,
        geocoded,
        address: (b.address ?? "").trim() || null,
        developer: (b.developer ?? "").trim() || null,
      };
    });
}

export const getAllBuildings = unstable_cache(
  fetchAllBuildings,
  ["public-buildings"],
  { revalidate: 300 },
);

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
  price_raw_text?: string | null;
  price_model?: string | null;
  price_per_sqft?: number | null;
  area_sqft?: number | null;
  furnishing: string | null;
  intent: string | null;
  asset_type: string | null;
  property_type: string | null;
  micro_market: string | null;
  locality_raw?: string | null;
  locality_resolved?: string | null;
  view: string | null;
  floor_description: string | null;
  building_name: string | null;
  broker_name: string | null;
  broker_id?: number | null;
  broker_phone: string | null;
  last_seen: string | null;
  title: string | null;
  representative_raw_message_id: number | null;
  latest_raw_message_id: number | null;
};

export type AdditionalCharge = {
  label: string;
  amount: number | null;
  amount_type: "fixed" | "percent_of_price";
};

export type RawMessageInfo = {
  message: string | null;
  sender: string | null;
  groupName: string | null;
  timestamp: string | null;
};

function inferBuildingFromSource(message: string | null, locality: string | null): string | null {
  const lines = String(message || "").split(/\r?\n/).map((line) =>
    line.replace(/[\*_`~]/g, "").trim()).map((line) => {
      let value = line;
      while (value.startsWith("-") || value.startsWith(":") || value.startsWith("•")) value = value.slice(1).trim();
      while (value.endsWith("-") || value.endsWith(":") || value.endsWith(",") || value.endsWith(".")) value = value.slice(0, -1).trim();
      return value;
    }).filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\b\d+(?:\.\d+)?\s*(?:bhk|rk)\b/i.test(lines[i])) continue;
    for (const candidate of lines.slice(i + 1, i + 5)) {
      if (!candidate || candidate.length > 70 || candidate.toLowerCase() === (locality || "").toLowerCase()) continue;
      if (/\b(?:prime location|location|rent|sale|lease|available|carpet|area|status|floor|parking|possession|inspection|photos?|contact|details|site visit|brokerage)\b/i.test(candidate)) continue;
      if (/[₹]|\b\d{5,}\b|\b(?:sq\.?\s*ft|lakh|lakhs?|crore|cr|per\s+month)\b/i.test(candidate)) continue;
      if (/[A-Za-z]/.test(candidate)) return candidate;
    }
  }
  return null;
}

export type ListingDetail = BuildingListing & {
  area_sqft: number | null;
  landmark_name: string | null;
  location_label: string | null;
  buildingSlug: string | null;
  localitySlug: string | null;
  deal_tags: string[];
  additional_charges: AdditionalCharge[];
  detailFields: Record<string, unknown>;
  rawMessage: RawMessageInfo | null;
};

// A real building name is short and Proper-noun-like. Ingestion sometimes
// stores an entire message as building_name (e.g. "Available Commercial Space
// For Rent at Near Pali Village..."), which then leaks into buildings.canonical_name
// and renders as a garbage /buildings/[slug] page. Reject those as 404s.
const JUNK_AD_PHRASES =
  /(available|commercial space|for rent|for sale|on rent|on sale|outright|unfurnished|furnished|furnish|semi furnished|car parking|carpet|built up|super area|sq\.? ?ft|sqft|\d\s*bhk|\bbhk|rent|sale|possession|inventory|inventories|direct inventory|direct inventories|video available)/i;
const SOCIETY_WORDS =
  /\b(society|chs|chsl|co[- ]?op|cooperative|housing|apartment|apartments|niwas|park|phase|tower|towers|complex|heights|residency|building|estate|enclave|gardens|residences|layout)\b/i;
// Broker / agency names mistakenly stored as building_name. These should never
// render as a building card (clicking them 404s on /buildings/<slug>).
const BROKER_NAME_PHRASES =
  /\b(real estate|realtors?|broker|broking|properties?|property consultant|consultants?|ventures?|realty)\b/i;
// Sentence-like fragments that are descriptions, not building names
// (e.g. "Located In Industrial Estate", "Opposite Railway Station").
const SENTENCE_PHRASES =
  /^(located in|situated at|near|opposite|beside|behind|next to|adjacent to|in front of|behind|above|below|ground floor|first floor|basement|annexe|wing|block|flat)\b/i;

// Extract the clean building name from a dirty listing.building_name value.
// The extraction pipeline often stores the ENTIRE ad message as building_name
// (e.g. "Wallfort Tower, 2bhk Available For Sale, 740 Sqft, Quote 2.40cr").
// Real building names are short and appear at the start, before ad text.
export function cleanBuildingName(raw: string | null): string | null {
  if (!raw) return null;
  const name = raw.replace(/[*_`~]/g, "").replace(/\s{2,}/g, " ").trim();
  if (!name) return null;

  // Short names are likely already clean — use as-is.
  if (name.length <= 40 && !isJunkBuildingName(name)) return name;

  // Try first segment before comma — real building names are usually the first
  // part before ad details kick in (e.g. "Wallfort Tower" from
  // "Wallfort Tower, 2bhk Available For Sale, 740 Sqft...").
  const firstSegment = name.split(",")[0].trim();
  if (firstSegment.length >= 3 && firstSegment.length <= 50 && !isJunkBuildingName(firstSegment)) {
    return firstSegment;
  }

  // If the whole name is junk, return null.
  if (isJunkBuildingName(name)) return null;

  return name;
}

const JUNK_LEADING = /^[.\*◇\-_📍🔥]+/;
// Pure ad/bhk/area fragments with no proper-noun building name, e.g.
// "1bhk", "2.5bhk", "1rk", "1850 carpet", "3.5 Bhk".
const PURE_FRAGMENT =
  /^\s*(?:[0-9]+(\.[0-9]+)?\s*(?:bhk|rk|bhk\+bhk|jodi)?\s*|[0-9,]+\s*(?:carpet|sqft|sq\.?\s*ft|sqm|area)?\s*|bhk\s*[\+/]?\s*bhk\s*)*$/i;

export function isJunkBuildingName(name: string | null): boolean {
  if (!name) return true;
  const n = name.trim();
  if (n.length < 3) return true;
  // Real building names never start with a digit (e.g. "1bhk New Inventory",
  // "2.5bhk For Resale In Shiv Shivam Tower" are ad fragments leaked
  // from the WhatsApp message body, not actual buildings).
  if (/^\d/.test(n)) return true;

  const lower = n.toLowerCase();
  // Pure BHK / area fragments are never buildings.
  if (PURE_FRAGMENT.test(n)) return true;
  // Broker / agency names are never buildings — exclude them outright, even
  // though some (e.g. "estate") overlap with legitimate society suffixes.
  if (BROKER_NAME_PHRASES.test(lower)) return true;
  // Sentence-like fragments describing a location, not actual building names.
  if (SENTENCE_PHRASES.test(n)) return true;

  const words = n.split(/\s+/).filter(Boolean);
  const hasAd = JUNK_AD_PHRASES.test(lower);

  // Names with BOTH a society word AND ad phrases / long length are ad text
  // leaked from WhatsApp messages (e.g. "Wallflort Tower, 2bhk Available For
  // Sale, 740 Sqft"). Real building names never embed BHK counts, carpet
  // areas, or price details.
  if (SOCIETY_WORDS.test(lower)) {
    if (hasAd && words.length >= 3) return true;
    if (n.length > 60) return true;
    return false;
  }

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

  // Most public building slugs are a normalized building name. Resolve that
  // common case directly; keep the paginated scan below for legacy names whose
  // punctuation/casing cannot be reconstructed from the slug.
  const directName = rawSlug.replace(/-/g, " ").trim();
  if (directName) {
    const { data: directRows } = await db
      .from("buildings")
      .select("id, canonical_name, micro_market, latitude, longitude, address, developer, enrichment_confidence")
      .ilike("canonical_name", directName)
      .limit(10);
    const direct = (directRows ?? []).find((b) => slugify(b.canonical_name ?? "") === slug);
    if (direct && !isJunkBuildingName(direct.canonical_name ?? "")) {
      return {
        id: direct.id ?? null,
        name: (direct.canonical_name ?? "").trim(),
        slug,
        microMarket: (direct.micro_market ?? "").trim() || null,
        address: (direct.address ?? "").trim() || null,
        developer: (direct.developer ?? "").trim() || null,
        geocoded: direct.latitude != null && direct.longitude != null,
        enrichmentConfidence:
          typeof direct.enrichment_confidence === "number" ? direct.enrichment_confidence : null,
      };
    }
  }

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

export async function getBuildingListings(name: string, locality?: string | null): Promise<BuildingListing[]> {
  const db = getServerSupabase();
  if (!db || !name.trim()) return [];

  // Filter at the DB layer (exact canonical name) and paginate past the 1000-row
  // cap so a building with >100 listings shows them all.
  const target = name.trim();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const PAGE = 1000;
  let all: Array<{
    id: number;
    bhk: string | null;
    price: number | null;
    price_unit: string | null;
    price_raw_text: string | null;
    price_model: string | null;
    price_per_sqft: number | null;
    area_sqft: number | null;
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
    raw_message: string | null;
  }> = [];

  for (let offset = 0; ; offset += PAGE) {
    let query = db
      .from("listings_unified")
      .select(
        "id, bhk, price, price_unit, price_raw_text, price_model, price_per_sqft, area_sqft, furnishing, intent, asset_type, property_type, micro_market, view, floor_description, building_name, broker_name, broker_phone, last_seen, representative_raw_message_id, latest_raw_message_id, raw_message",
      )
      .ilike("building_name", target)
      .gte("last_seen", thirtyDaysAgo)
      .eq("needs_review", false);
    const localitySlug = locality ? canonicalLocality(locality).slug : null;
    if (localitySlug) query = query.eq("canonical_micro_market_slug", localitySlug);
    const { data, error } = await query
      .order("last_seen", { ascending: false })
      .range(offset, offset + PAGE - 1);

    if (error) {
      console.error("getBuildingListings error:", error.message);
      return [];
    }
    all = all.concat((data ?? []) as typeof all);
    if (!data || data.length < PAGE) break;
  }

  // Correct stale typed BHK values from the source evidence before deduping.
  // Otherwise a repost can appear as a second unit merely because one row says
  // 1 BHK and another says 3 BHK.
  const visible = dedupeRecentListings(all.map((r) => ({
    ...r,
    bhk: normalizeBhkFromEvidence(r.bhk, r.raw_message),
  })));

  // Real titles are computed at ingestion time and stored on parsed_output,
  // keyed by the raw WhatsApp message — not on the listings row itself.
  const titleMap = await getTitlesForRawMessageIds(
    visible.flatMap((r) => [r.representative_raw_message_id, r.latest_raw_message_id]),
  );

  return visible.map((r) => ({
    id: r.id,
    bhk: r.bhk,
    price: r.price,
    price_unit: r.price_unit,
    price_raw_text: r.price_raw_text,
    price_model: r.price_model,
    price_per_sqft: r.price_per_sqft,
    area_sqft: r.area_sqft,
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

export async function getListingById(id: number, requestedSlug?: string): Promise<ListingDetail | null> {
  const db = getServerSupabase();
  if (!db || !Number.isFinite(id)) return null;

  const { data: candidates, error } = await db
    .from("listings_unified")
    .select(
      "id, card_type, bhk, price, price_unit, price_raw_text, price_model, price_per_sqft, area_sqft, furnishing, intent, asset_type, property_type, location_label, landmark_name, micro_market, locality_raw, locality_resolved, view, floor_description, broker_id, broker_name, broker_phone, last_seen, building_name, representative_raw_message_id, representative_listing_index, latest_raw_message_id, deal_tags, additional_charges",
    )
    .eq("id", id)
    .limit(25);

  if (error || !candidates?.length) {
    if (error) console.error("getListingById error:", error.message);
    return null;
  }

  // listings_unified is a UNION of four typed tables, whose local sequences
  // can overlap. The URL slug is the disambiguator for legacy numeric URLs.
  // If it cannot identify exactly one row, do not silently show another
  // property under the requested URL.
  const matching = requestedSlug
    ? candidates.filter((candidate) => {
        const slugInputs = [
          {
            id: Number(candidate.id),
            bhk: candidate.bhk,
            micro_market: candidate.micro_market,
            building_name: candidate.building_name,
            property_type: candidate.property_type,
            intent: candidate.intent,
          },
          // Older building pages emitted a short BHK-only slug. Keep those
          // links resolvable, then the detail page redirects to the canonical
          // long-tail URL.
          { id: Number(candidate.id), bhk: candidate.bhk },
        ];
        return slugInputs.some((input) => buildListingSlug(input) === requestedSlug) ||
          // Preserve compatibility with older simple building/locality URLs.
          slugify(String(candidate.building_name || candidate.micro_market || "")) === requestedSlug;
      })
    : candidates;
  const legacyNumericSlug = Boolean(requestedSlug && /^\d+$/.test(requestedSlug) && Number(requestedSlug) === id);
  const identityKey = (candidate: (typeof candidates)[number]) => [
    String(candidate.building_name || "").trim().toLowerCase(),
    String(candidate.micro_market || candidate.location_label || "").trim().toLowerCase(),
  ].join("|");
  const sameProperty = candidates.length > 1 && new Set(candidates.map(identityKey)).size === 1;
  const legacyCandidate = legacyNumericSlug && sameProperty
    ? [...candidates].sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")))[0]
    : null;
  const data = matching.length === 1
    ? matching[0]
    : candidates.length === 1
      ? candidates[0]
      : legacyCandidate;
  if (!data) return null;

  const rawMsgId = data.representative_raw_message_id ?? data.latest_raw_message_id;
  const listingIndex = data.representative_listing_index ?? 0;

  let rawMessage: RawMessageInfo | null = null;
  if (rawMsgId) {
    try {
      const { data: slice } = await db
        .from("parsed_output_unified")
        .select("normalized_message")
        .eq("raw_message_id", rawMsgId)
        .eq("listing_index", listingIndex)
        .maybeSingle();
      if (slice) {
        rawMessage = {
          message: slice?.normalized_message ?? null,
          sender: null,
          groupName: null,
          timestamp: null,
        };
      }
    } catch {
      // Non-critical; don't block the page
    }
  }

  let brokerName = data.broker_name;
  if (data.broker_id != null) {
    const { data: broker } = await db
      .from("brokers")
      .select("canonical_name")
      .eq("id", data.broker_id)
      .maybeSingle();
    brokerName = displayableBrokerName(broker?.canonical_name ?? null) || brokerName;
  }

  const detailTableByCard: Record<string, string> = {
    residential_sale: "residential_sale_listings",
    residential_rent: "residential_rent_listings",
    commercial_sale: "commercial_sale_listings",
    commercial_rent: "commercial_rent_listings",
  };
  const detailSelectByCard: Record<string, string> = {
    residential_sale: "bathroom_count,carpet_area_sqft,built_up_area_sqft,super_built_up_area_sqft,area_raw_text,car_parking_count,parking_type,floor_range,building_amenities,unit_amenities,property_view,orientation,brokerage_type,developer_name,possession_status,age_of_property,occupancy_status",
    residential_rent: "bathroom_count,carpet_area_sqft,built_up_area_sqft,area_raw_text,deposit_amount,deposit_months,car_parking_count,parking_type,floor_range,building_amenities,unit_amenities,pet_policy,tenant_type_preference,sharing_allowed,tenant_nationality_preference,lease_term_type,lock_in_period_months,notice_period_months,property_view,brokerage_type,possession_status",
    commercial_sale: "commercial_use_type,carpet_area_sqft,built_up_area_sqft,chargeable_area_sqft,saleable_area_sqft,area_raw_text,car_parking_count,parking_type,floor_level,floor_range,building_amenities,fitout_status,ceiling_height,occupancy_status,has_lift,has_power_backup,brokerage_type,developer_name",
    commercial_rent: "commercial_use_type,carpet_area_sqft,built_up_area_sqft,chargeable_area_sqft,area_raw_text,deposit_amount,deposit_months,car_parking_count,parking_type,floor_level,floor_range,building_amenities,fitout_status,ceiling_height,has_lift,has_power_backup,lease_term_type,lock_in_period_months,notice_period_months,brokerage_type",
  };
  let detailFields: Record<string, unknown> = {};
  const detailTable = detailTableByCard[data.card_type];
  const detailSelect = detailSelectByCard[data.card_type];
  if (detailTable && detailSelect) {
    const { data: details } = await db
      .from(detailTable)
      .select(detailSelect)
      .eq("id", data.id)
      .maybeSingle();
    detailFields = (details ?? {}) as Record<string, unknown>;
  }

  return {
    id: data.id,
    bhk: data.bhk,
    price: data.price,
    price_unit: data.price_unit,
    price_raw_text: data.price_raw_text ?? null,
    price_model: data.price_model ?? null,
    price_per_sqft: data.price_per_sqft ?? null,
    area_sqft: data.area_sqft,
    furnishing: data.furnishing,
    intent: data.intent,
    asset_type: data.asset_type,
    property_type: data.property_type,
    micro_market: data.micro_market,
    locality_raw: data.locality_raw ?? null,
    locality_resolved: data.locality_resolved ?? null,
    view: data.view,
    floor_description: data.floor_description,
    building_name: cleanBuildingName(data.building_name) || inferBuildingFromSource(rawMessage?.message ?? null, data.micro_market),
    landmark_name: data.landmark_name,
    location_label: data.location_label,
    broker_name: brokerName,
    broker_phone: data.broker_phone,
    broker_id: data.broker_id ?? null,
    last_seen: data.last_seen,
    // The card title is deterministic from typed fields; avoid an extra
    // parsed_output title lookup on every public detail request.
    title: null,
    representative_raw_message_id: data.representative_raw_message_id,
    latest_raw_message_id: data.latest_raw_message_id,
    deal_tags: Array.isArray(data.deal_tags) ? data.deal_tags : [],
    additional_charges: Array.isArray(data.additional_charges) ? data.additional_charges : [],
    detailFields,
    buildingSlug:
      data.building_name && !isJunkBuildingName(data.building_name) ? slugify(data.building_name) : null,
    localitySlug: data.micro_market ? slugify(data.micro_market) : null,
    rawMessage,
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

// Lightweight projection of `listings` for the sitemap. Returns only the
// fields we need to compute a slug and a lastModified timestamp; nothing
// sensitive (no phone, no broker name) so it stays inside the public
// surface. Filters to the last `sinceDays` so dead listings don't waste
// Google crawl budget.
export type SitemapListingRow = {
  id: number;
  last_seen: string | null;
  micro_market: string | null;
  bhk: string | null;
  building_name: string | null;
  property_type: string | null;
};

export async function getRecentListingsForSitemap(
  opts: { sinceDays: number; limit: number },
): Promise<SitemapListingRow[]> {
  const db = getServerSupabase();
  if (!db) return [];
  const sinceMs = Date.now() - opts.sinceDays * 86_400_000;
  const sinceIso = new Date(sinceMs).toISOString();
  const { data, error } = await db
    .from("listings_unified")
    .select("id, last_seen, micro_market, bhk, building_name, property_type")
    .gte("last_seen", sinceIso)
    .order("last_seen", { ascending: false })
    .limit(opts.limit);
  if (error) {
    console.error("getRecentListingsForSitemap error:", error.message);
    return [];
  }
  return (data ?? []) as SitemapListingRow[];
}

export async function getBrokerAreas(
  brokerPhone: string | null,
): Promise<string[]> {
  if (!brokerPhone) return [];
  const db = getServerSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("listings_unified")
    .select("micro_market")
    .eq("broker_phone", brokerPhone)
    .not("micro_market", "is", null)
    .neq("micro_market", "");
  if (error || !data) return [];
  const counts = new Map<string, number>();
  for (const row of data) {
    const mm = (row.micro_market ?? "").trim();
    if (!mm) continue;
    counts.set(mm, (counts.get(mm) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
}

export type BuildingBroker = {
  name: string;
  listingCount: number;
};

function displayableBrokerName(value: string | null): string | null {
  let name = (value || "").replace(/[\*_`~]/g, "").replace(/\s+/g, " ").trim();
  const quoted = name.match(/["“”']([^"“”']{2,80})["“”']/);
  if (quoted) name = quoted[1].trim();
  if (!name || /@s\.whatsapp\.net$|@lid$|@g\.us$/i.test(name) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name) || /^\+?\d{7,}$/.test(name)) return null;
  if (/^(call|contact|kindly|please|whatsapp|brokerage|available)$/i.test(name) || /^(kindly|please)\b/i.test(name)) return null;
  return name;
}

/** Return distinct brokers currently posting the same building. The prefix
 * deliberately groups small spelling variants such as Silverline/Silverine;
 * locality keeps similarly named buildings apart.
 */
export async function getBuildingBrokers(
  buildingName: string | null,
  locality: string | null,
): Promise<BuildingBroker[]> {
  const raw = (buildingName || "").trim();
  if (!raw) return [];
  const db = getServerSupabase();
  if (!db) return [];
  const words = raw.split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] || raw;
  const stem = last.length > 5 ? last.slice(0, last.length - 3) : last;
  const prefix = `${words.slice(0, -1).join(" ")}${words.length > 1 ? " " : ""}${stem}`;
  let query = db
    .from("listings_unified")
    .select("broker_id, broker_name, building_name, micro_market")
    .ilike("building_name", `${prefix}%`)
    .not("broker_name", "is", null)
    .limit(500);
  if (locality) query = query.eq("micro_market", locality);
  const { data, error } = await query;
  if (error || !data) return [];
  const brokerIds = [...new Set(data.map((row) => row.broker_id).filter((id): id is number => typeof id === "number"))];
  const canonicalById = new Map<number, string>();
  if (brokerIds.length > 0) {
    const { data: brokers } = await db.from("brokers").select("id, canonical_name").in("id", brokerIds);
    for (const broker of brokers ?? []) {
      const name = displayableBrokerName(broker.canonical_name);
      if (name) canonicalById.set(broker.id, name);
    }
  }
  const counts = new Map<string, { name: string; count: number }>();
  for (const row of data) {
    const name = (typeof row.broker_id === "number" ? canonicalById.get(row.broker_id) : null)
      || displayableBrokerName(row.broker_name);
    if (!name) continue;
    const displayName = name.replace(/\s*-\s*\d+\s*$/i, "").trim();
    const key = displayName.toLocaleLowerCase();
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { name: displayName, count: 1 });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
    .map(([, value]) => ({ name: value.name, listingCount: value.count }));
}

export async function getSimilarListingsForExpired(
  opts: { micro_market: string | null; bhk: string | null; intent: string | null; limit?: number },
): Promise<Array<{ id: number; micro_market: string | null; bhk: string | null; building_name: string | null; price: number | null; price_unit: string | null; last_seen: string | null; property_type: string | null }>> {
  const db = getServerSupabase();
  if (!db) return [];

  const limit = opts.limit ?? 5;
  const freshnessCutoff = new Date();
  freshnessCutoff.setDate(freshnessCutoff.getDate() - 90);
  const freshnessCutoffIso = freshnessCutoff.toISOString();

  let query = db.from("listings_unified").select("id, micro_market, bhk, building_name, price, price_unit, last_seen, property_type").gte("last_seen", freshnessCutoffIso);

  if (opts.micro_market) {
    query = query.eq("micro_market", opts.micro_market);
  }
  if (opts.bhk) {
    query = query.eq("bhk", opts.bhk);
  }
  if (opts.intent) {
    query = query.eq("intent", opts.intent);
  }

  const { data, error } = await query.order("last_seen", { ascending: false }).limit(limit);
  if (error || !data) return [];
  return dedupeRecentListings(data.map((row) => ({
    id: row.id,
    micro_market: row.micro_market,
    bhk: row.bhk,
    building_name: row.building_name,
    price: row.price,
    price_unit: row.price_unit,
    intent: opts.intent,
    last_seen: row.last_seen,
    property_type: row.property_type,
    broker_name: null,
    broker_phone: null,
    area_sqft: null,
    floor_description: null,
    landmark_name: null,
    locality_raw: null,
    locality_resolved: null,
  })));
}

export async function getSimilarListingsForDetail(opts: {
  id: number;
  building_name: string | null;
  micro_market: string | null;
  bhk: string | null;
  intent: string | null;
  property_type?: string | null;
  asset_type?: string | null;
  furnishing: string | null;
  price: number | null;
  broker_id?: number | null;
  broker_name?: string | null;
  broker_phone?: string | null;
  floor_description?: string | null;
  limit?: number;
}): Promise<ListingCardFields[]> {
  const db = getServerSupabase();
  if (!db || !opts.micro_market) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const { data, error } = await db
    .from("listings_unified")
    .select("id, bhk, price, price_unit, price_raw_text, price_model, price_per_sqft, area_sqft, furnishing, intent, asset_type, property_type, micro_market, locality_raw, locality_resolved, building_name, landmark_name, location_label, floor_description, broker_id, view, broker_name, broker_phone, last_seen, deal_tags, additional_charges")
    .eq("intent", opts.intent)
    .neq("id", opts.id)
    .gte("last_seen", cutoff.toISOString())
    .limit(400);
  if (error || !data) return [];

  const targetBuilding = (opts.building_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const targetBhk = (opts.bhk || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const targetFurnishing = (opts.furnishing || "").toLowerCase();
  const norm = (value: unknown) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const targetPropertyType = norm(opts.property_type);
  const targetAssetType = norm(opts.asset_type);
  const targetBroker = norm(opts.broker_phone) || norm(opts.broker_name);
  const targetCoordsRaw = (await fetchBuildingsForNames(opts.building_name ? [opts.building_name] : [])).get((opts.building_name || "").toLowerCase());
  const targetCoords = targetCoordsRaw && targetCoordsRaw.latitude != null && targetCoordsRaw.longitude != null
    ? { latitude: targetCoordsRaw.latitude, longitude: targetCoordsRaw.longitude }
    : null;
  const buildingNames = (data as Array<{ building_name?: string | null }>).map((row) => row.building_name || "");
  const buildingCoords = await fetchBuildingsForNames(buildingNames);
  const distanceKm = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
    const radians = (value: number) => value * Math.PI / 180;
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const lat1 = radians(a.latitude);
    const lat2 = radians(b.latitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const ranked = dedupeRecentListings(data as ListingCardFields[]).map((row) => {
    const building = String(row.building_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    const bhk = String(row.bhk || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
    const furnishing = String(row.furnishing || "").toLowerCase();
    const rowPropertyType = norm(row.property_type);
    const rowAssetType = norm(row.asset_type);
    const rowWithIdentity = row as ListingCardFields & { broker_id?: number | null };
    const rowBroker = norm(row.broker_phone) || norm(row.broker_name);
    const sameBroker = (opts.broker_id != null && rowWithIdentity.broker_id === opts.broker_id)
      || Boolean(targetBroker && rowBroker && targetBroker === rowBroker);
    const sameBuilding = Boolean(building && targetBuilding && building === targetBuilding);
    const differentKnownFloor = Boolean(opts.floor_description && row.floor_description && norm(opts.floor_description) !== norm(row.floor_description));
    const likelyDuplicate = sameBroker && sameBuilding && bhk === targetBhk && !differentKnownFloor;
    const rowCoordsRaw = buildingCoords.get(String(row.building_name || "").toLowerCase());
    const rowCoords = rowCoordsRaw && rowCoordsRaw.latitude != null && rowCoordsRaw.longitude != null
      ? { latitude: rowCoordsRaw.latitude, longitude: rowCoordsRaw.longitude }
      : null;
    const distance = targetCoords && rowCoords ? distanceKm(targetCoords, rowCoords) : null;
    const sameLocality = norm(row.micro_market) === norm(opts.micro_market);
    const tier = sameBuilding
      ? 0
      : distance != null && distance <= 0.5
        ? 1
        : distance != null && distance <= 1
          ? 2
          : distance != null && distance <= 2
            ? 3
            : sameLocality
              ? 4
              : 5;
    const reason = tier === 0 ? "Same building" : tier === 1 ? "Within 500m" : tier === 2 ? "Within 1km" : tier === 3 ? "Within 2km" : tier === 4 ? "Same locality" : "Nearby area";
    const compatibleType = (!targetPropertyType || !rowPropertyType || rowPropertyType === targetPropertyType)
      && (!targetAssetType || !rowAssetType || rowAssetType === targetAssetType);
    const compatibleBhk = !targetBhk || !bhk || bhk === targetBhk;
    if (!compatibleType || !compatibleBhk || (!targetCoords && !sameLocality)) return { row, score: -1, likelyDuplicate, tier, reason };
    let score = (5 - tier) * 100;
    if (targetBhk && bhk === targetBhk) score += 45;
    if (targetFurnishing && furnishing === targetFurnishing) score += 25;
    if (opts.price && row.price) {
      const delta = Math.abs(Number(row.price) - opts.price) / opts.price;
      if (delta <= 0.2) score += 20;
      else if (delta <= 0.4) score += 8;
    }
    return { row: { ...row, recommendation_reason: reason }, score, likelyDuplicate, tier, reason };
  });
  return ranked
    .filter(({ likelyDuplicate, score }) => !likelyDuplicate && score >= 0)
    .sort((a, b) => a.tier - b.tier || b.score - a.score || String(b.row.last_seen || "").localeCompare(String(a.row.last_seen || "")))
    .slice(0, opts.limit ?? 6)
    .map(({ row }) => row as ListingCardFields);
}
