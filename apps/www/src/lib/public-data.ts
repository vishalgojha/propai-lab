import { getServerSupabase } from "./supabase";
import { getAllBuildings, getAllLocalities, type BuildingSummary, type LocalitySummary } from "./localities";
import { dedupeRecentListings, normalizeBhkFromEvidence } from "./listing-card";
import { isPublicListingEligible } from "./public-eligibility";

export type PublicCountKey =
  | "localities"
  | "buildings"
  | "listings"
  | "activeListings"
  | "brokers"
  | "raw_messages"
  | "messagesAnalysed";

export type PublicListingSummary = {
  id: number;
  card_type?: string | null;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  furnishing: string | null;
  location_label: string | null;
  building_name: string | null;
  summary_title?: string | null;
  landmark_name: string | null;
  micro_market: string | null;
  broker_name: string | null;
  broker_phone?: string | null;
  intent?: string | null;
  area_sqft?: number | null;
  floor_description?: string | null;
  property_type?: string | null;
  observation_count: number | null;
  last_seen: string | null;
  price_raw_text?: string | null;
  source_text?: string | null;
  source_notes?: string | null;
  photo_count?: number;
  opportunity_key?: string | null;
};

export type PublicListingPhoto = {
  id: number;
  url: string;
  caption: string | null;
};

export async function getPublicListingPhotos(listingId: number): Promise<PublicListingPhoto[]> {
  const db = getServerSupabase();
  if (!db || !Number.isFinite(listingId)) return [];
  const { data, error } = await db
    .from("listing_photos")
    .select("id, storage_path, mime_type, caption")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    console.error("public listing photos query error:", error.message);
    return [];
  }
  const photos: PublicListingPhoto[] = [];
  for (const row of data ?? []) {
    const path = String(row.storage_path || "").trim();
    if (!path) continue;
    const signed = await db.storage.from("whatsapp-media").createSignedUrl(path, 3600);
    if (signed.error || !signed.data?.signedUrl) continue;
    photos.push({ id: Number(row.id), url: signed.data.signedUrl, caption: row.caption || null });
  }
  return photos;
}

function priceFromRawText(value: unknown): number | null {
  const match = String(value ?? "").match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(cr(?:ore)?|lakh|lac|l|k|thousand)?\b/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] || "").toLowerCase();
  const multiplier = unit.startsWith("cr") ? 1_00_00_000
    : unit === "l" || unit.startsWith("lac") || unit === "lakh" ? 1_00_000
      : unit === "k" || unit.startsWith("thousand") ? 1_000 : 1;
  return amount * multiplier;
}

export type PublicBrokerSummary = {
  display_name: string;
  listing_count: number | null;
  market_count: number | null;
};

export type PublicDataOverview = {
  counts: Record<PublicCountKey, number>;
  /** False when the live count query could not be read. */
  countsAvailable: boolean;
  activity: PublicActivityPoint[];
  topLocalities: LocalitySummary[];
  topBuildings: BuildingSummary[];
  recentListings: PublicListingSummary[];
};

export type PublicActivityPoint = {
  date: string;
  messages: number;
  parsedRecords: number;
  listings: number;
};

function priceLabel(
  value: number | null,
  unit: string | null,
  intent: string | null = null,
  rawText: string | null = null,
): string {
  if (value == null || value <= 0) return "Price on request";
  const isRent = /^(rent|rental|lease)$/i.test(String(intent || ""));
  // Tiny absolute values are parser/database corruption, not Mumbai market
  // prices. Never expose them as believable public inventory numbers.
  if (isRent ? value < 1_000 : value < 1_00_000) return "Price on request";
  if (rawText && isRent) {
    const match = rawText.match(/(?:rent|lease|monthly|price|asking)\s*[:=-]?[^\d₹]{0,20}(?:₹|rs\.?|inr\s*)?\s*(\d[\d,]*(?:\.\d+)?)\s*(cr|crore|lakh|lac|l|k|thousand)?/i);
    if (match) {
      const amount = Number(match[1].replace(/,/g, ""));
      const rawUnit = (match[2] || "").toLowerCase();
      const absolute = rawUnit === "cr" || rawUnit === "crore"
        ? amount * 1_00_00_000
        : rawUnit === "lakh" || rawUnit === "lac" || rawUnit === "l"
          ? amount * 1_00_000
          : rawUnit === "k" && match[1].includes(".") && amount < 5
            ? amount * 1_00_000
            : rawUnit === "k" || rawUnit === "thousand" ? amount * 1_000 : amount;
      if (Number.isFinite(absolute) && absolute >= 1_000) {
        const lakh = absolute / 1_00_000;
        return absolute >= 1_00_00_000
          ? `₹${(absolute / 1_00_00_000).toFixed(2)} Cr`
          : absolute >= 1_00_000
            ? `₹${lakh % 1 === 0 ? lakh : lakh.toFixed(2)} Lakh`
            : `₹${Math.round(absolute).toLocaleString("en-IN")}`;
      }
    }
  }
  // The public listings view normalizes prices to absolute rupees and uses
  // `price_unit = abs`. Older rows may retain `cr`/`lac`, but the numeric value
  // is still absolute. Format the amount by scale so the homepage never leaks
  // grouped rupee values such as ₹4,30,000 instead of ₹4.30 Lakh.
  if (value >= 1_00_00_000) {
    const cr = value / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(2)} Cr`;
  }
  if (value >= 1_00_000) {
    const lakh = value / 1_00_000;
    return `₹${lakh % 1 === 0 ? lakh : lakh.toFixed(2)} Lakh`;
  }
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

export function formatPublicPrice(
  value: number | null,
  unit: string | null,
  intent: string | null = null,
  rawText: string | null = null,
): string {
  return priceLabel(value, unit, intent, rawText);
}

function buildActivityTimeline(rows: Array<{ created_at: string | null }>, days = 14): PublicActivityPoint[] {
  const points = new Map<string, PublicActivityPoint>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const key = date.toISOString().slice(0, 10);
    points.set(key, { date: key, messages: 0, parsedRecords: 0, listings: 0 });
  }

  for (const row of rows) {
    if (!row.created_at) continue;
    const key = row.created_at.slice(0, 10);
    const entry = points.get(key);
    if (entry) entry.messages += 1;
  }

  return Array.from(points.values());
}

export async function getPublicDataOverview(options?: {
  localities?: LocalitySummary[];
  buildings?: BuildingSummary[];
  skipBuildingScan?: boolean;
  skipCounts?: boolean;
  skipLocalities?: boolean;
  skipActivity?: boolean;
}): Promise<PublicDataOverview> {
  const db = getServerSupabase();

  // Single RPC for the counters. If the RPC is unavailable to the public
  // runtime role, recover from the same read paths used for live listings
  // instead of making the whole homepage look empty.
  const countsPromise = db && !options?.skipCounts ? db.rpc("get_public_counts").then(async (res) => {
    if (res.error) {
      console.error("get_public_counts error:", res.error.message);
      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [listings, activeListings, brokers, rawMessages] = await Promise.all([
        db.from("listings_unified").select("id", { count: "exact", head: true }).eq("needs_review", false),
        db.from("listings_unified").select("id", { count: "exact", head: true }).gte("last_seen", cutoff).eq("needs_review", false),
        db.from("brokers").select("id", { count: "exact", head: true }),
        db.from("raw_messages").select("id", { count: "exact", head: true }),
      ]);
      const values = [listings, activeListings, brokers, rawMessages];
      if (values.some((value) => value.error)) return null;
      return {
        listings_total: listings.count ?? 0,
        listings_active_30d: activeListings.count ?? 0,
        brokers: brokers.count ?? 0,
        raw_messages: rawMessages.count ?? 0,
      };
    }
    return res.data?.[0] ?? null;
  }) : Promise.resolve(null);

  const [localities, buildings, countsRow] = await Promise.all([
    options?.localities ?? (options?.skipLocalities ? Promise.resolve([]) : getAllLocalities()),
    options?.buildings ?? (options?.skipBuildingScan ? Promise.resolve([]) : getAllBuildings(200)),
    countsPromise,
  ]);

  const listings = Number(countsRow?.listings_total ?? 0);
  const activeListings = Number(countsRow?.listings_active_30d ?? 0);
  const brokers = Number(countsRow?.brokers ?? 0);
  const rawMessages = Number(countsRow?.raw_messages ?? 0);
  const buildingCount = Number(countsRow?.buildings ?? countsRow?.buildings_total ?? buildings.length);

  const topBuildings = [...buildings]
    .sort((a, b) => b.listingCount - a.listingCount || a.name.localeCompare(b.name))
    .slice(0, 8);

  const recentListings: PublicListingSummary[] = [];
  const activity: PublicActivityPoint[] = [];
  const days = 14;

  if (db) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffIso = cutoff.toISOString();
    // `listings_unified` is a wide UNION view. Query the four typed tables
    // directly so a slow compatibility view cannot blank the homepage.
    const recentSpecs = [
      { table: "residential_sale_listings", cardType: "residential_sale", asset: "residential", intent: "sale", price: "total_asking_price", furnishing: "furnishing_status", hasBhk: true },
      { table: "residential_rent_listings", cardType: "residential_rent", asset: "residential", intent: "rent", price: "monthly_rent", furnishing: "furnishing_status", hasBhk: true },
      { table: "commercial_sale_listings", cardType: "commercial_sale", asset: "commercial", intent: "sale", price: "total_asking_price", furnishing: "fitout_status", hasBhk: false },
      { table: "commercial_rent_listings", cardType: "commercial_rent", asset: "commercial", intent: "rent", price: "monthly_rent", furnishing: "fitout_status", hasBhk: false },
    ] as const;
    const RECENT_PER_TABLE = 100;
    const recentRows = (await Promise.all(recentSpecs.map(async (spec) => {
      const selection = `id, ${spec.hasBhk ? "bhk, " : ""}${spec.price}, price_raw_text, raw_payload, carpet_area_sqft, ${spec.furnishing}, summary_title, building_name, landmark_name, micro_market, locality_resolved, locality_raw, broker_name, broker_phone, source_notes, opportunity_key, created_at, updated_at, last_seen_at`;
      const { data, error } = await db
        .from(spec.table)
        .select(selection)
        .order("updated_at", { ascending: false, nullsFirst: false })
        .limit(RECENT_PER_TABLE);
      if (error) {
        console.error(`homepage ${spec.table} error:`, error.message);
        return [];
      }
      return (data ?? []).filter((row: any) => isPublicListingEligible({ ...row, asset_type: spec.asset, property_type: spec.asset })).map((row: any) => ({
        ...row,
        bhk: spec.hasBhk
          ? normalizeBhkFromEvidence(row.bhk ?? null, row.raw_payload?.full_text)
          : null,
        card_type: spec.cardType,
        asset_type: spec.asset,
        intent: spec.intent,
        property_type: spec.asset,
        price: row[spec.price] ?? priceFromRawText(row.price_raw_text ?? row.raw_payload?.full_text),
        price_unit: "abs",
        furnishing: row[spec.furnishing] ?? null,
        area_sqft: row.carpet_area_sqft ?? null,
        location_label: row.micro_market || row.locality_resolved || row.locality_raw || null,
        last_seen: row.last_seen_at ?? row.updated_at ?? row.created_at ?? null,
        observation_count: null,
        price_raw_text: row.price_raw_text ?? null,
        source_text: row.raw_payload?.full_text ?? null,
        opportunity_key: row.opportunity_key ?? null,
      }));
    }))).flat().sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || ""))).slice(0, 200);

    const [rawRowsRes, parsedRowsRes, listingRowsRes] = options?.skipActivity
      ? [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }]
      : await Promise.all([
          db.from("raw_messages").select("created_at").gte("created_at", cutoffIso),
          db.from("parsed_output_unified").select("created_at").gte("created_at", cutoffIso),
          db.from("listings_unified").select("created_at").gte("created_at", cutoffIso).eq("needs_review", false),
        ]);

    {
      const latestByOpportunity = new Map<string, typeof recentRows[number]>();
      const withoutExactReposts = recentRows.filter((row) => {
        const key = typeof row.opportunity_key === "string" ? row.opportunity_key.trim() : "";
        if (!key) return true;
        const previous = latestByOpportunity.get(key);
        if (!previous || String(row.last_seen || "") > String(previous.last_seen || "")) {
          latestByOpportunity.set(key, row);
          return true;
        }
        return false;
      });
      const rows = dedupeRecentListings(withoutExactReposts.map((row) => ({
        ...row,
        price_raw_text: row.price_raw_text ?? null,
        price_model: null,
        area_sqft: row.area_sqft ?? null,
        asset_type: null,
        property_type: row.property_type ?? null,
        locality_raw: null,
        locality_resolved: null,
        floor_description: row.floor_description ?? null,
        broker_phone: row.broker_phone ?? null,
        last_seen: row.last_seen ?? null,
        landmark_name: row.landmark_name ?? null,
        intent: row.intent ?? null,
      })));
      const photoCounts = new Map<number, number>();
      const listingIds = rows.map((row) => Number(row.id)).filter(Number.isFinite);
      if (listingIds.length > 0) {
        const photos = await db.from("listing_photos").select("listing_id").in("listing_id", listingIds);
        if (!photos.error) {
          for (const photo of photos.data ?? []) {
            const id = Number(photo.listing_id);
            photoCounts.set(id, (photoCounts.get(id) ?? 0) + 1);
          }
        }
      }
      for (const row of rows) {
        recentListings.push({ ...row, photo_count: photoCounts.get(Number(row.id)) ?? 0 } as PublicListingSummary);
      }
    }
    const rawRows = rawRowsRes.error ? [] : (rawRowsRes.data ?? []);
    const parsedRows = parsedRowsRes.error ? [] : (parsedRowsRes.data ?? []);
    const listingRows = listingRowsRes.error ? [] : (listingRowsRes.data ?? []);

    const base = buildActivityTimeline(rawRows, days);
    const byDate = new Map(base.map((point) => [point.date, point]));
    for (const row of parsedRows) {
      if (!row.created_at) continue;
      const key = row.created_at.slice(0, 10);
      const point = byDate.get(key);
      if (point) point.parsedRecords += 1;
    }
    for (const row of listingRows) {
      if (!row.created_at) continue;
      const key = row.created_at.slice(0, 10);
      const point = byDate.get(key);
      if (point) point.listings += 1;
    }
    activity.push(...base);
  }

  return {
    counts: {
      localities: localities.length,
      buildings: buildingCount,
      listings,
      activeListings,
      brokers,
      raw_messages: rawMessages,
      messagesAnalysed: rawMessages,
    },
    countsAvailable: countsRow !== null,
    activity,
    topLocalities: localities.slice(0, 8),
    topBuildings,
    recentListings,
  };
}
