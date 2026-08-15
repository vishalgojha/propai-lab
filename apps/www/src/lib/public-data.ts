import { getServerSupabase } from "./supabase";
import { getAllBuildings, getAllLocalities, type BuildingSummary, type LocalitySummary } from "./localities";
import { dedupeRecentListings } from "./listing-card";

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
};

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

function priceLabel(value: number | null, unit: string | null): string {
  if (value == null) return "Price on request";
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

export function formatPublicPrice(value: number | null, unit: string | null): string {
  return priceLabel(value, unit);
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
}): Promise<PublicDataOverview> {
  const db = getServerSupabase();

  // Single RPC for all 6 counts instead of 6 separate queries.
  const countsPromise = db ? db.rpc("get_public_counts").then((res) => {
    if (res.error) {
      console.error("get_public_counts error:", res.error.message);
      return null;
    }
    return res.data?.[0] ?? null;
  }) : Promise.resolve(null);

  const [localities, buildings, countsRow] = await Promise.all([
    options?.localities ?? getAllLocalities(),
    options?.buildings ?? getAllBuildings(200),
    countsPromise,
  ]);

  const listings = Number(countsRow?.listings_total ?? 0);
  const activeListings = Number(countsRow?.listings_active_30d ?? 0);
  const brokers = Number(countsRow?.brokers ?? 0);
  const rawMessages = Number(countsRow?.raw_messages ?? 0);

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
    const [recentRes] = await Promise.all([
      db
        .from("listings_unified")
        .select(
          "id, card_type, bhk, price, price_unit, furnishing, location_label, building_name, landmark_name, micro_market, broker_name, broker_phone, intent, area_sqft, floor_description, property_type, observation_count, last_seen",
        )
        .order("created_at", { ascending: false })
        // Fetch enough candidates to survive a burst of identical reposts;
        // deduplication happens before the homepage takes its first six.
        .limit(50),
    ]);

    const [rawRowsRes, parsedRowsRes, listingRowsRes] = await Promise.all([
      db.from("raw_messages").select("created_at").gte("created_at", cutoffIso),
      db.from("parsed_output_unified").select("created_at").gte("created_at", cutoffIso),
      db.from("listings_unified").select("created_at").gte("created_at", cutoffIso),
    ]);

    if (!recentRes.error) {
      const rows = dedupeRecentListings((recentRes.data ?? []).map((row) => ({
        ...row,
        price_raw_text: null,
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
      for (const row of rows) {
        recentListings.push(row as PublicListingSummary);
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
      buildings: buildings.length,
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
