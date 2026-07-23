import { getServerSupabase } from "./supabase";
import { getAllBuildings, getAllLocalities, type BuildingSummary, type LocalitySummary } from "./localities";

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
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  furnishing: string | null;
  location_label: string | null;
  building_name: string | null;
  landmark_name: string | null;
  micro_market: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  observation_count: number | null;
  last_seen: string | null;
};

export type PublicBrokerSummary = {
  canonical_name: string;
  primary_phone: string | null;
  observation_count: number | null;
  listing_count: number | null;
  requirement_count: number | null;
  market_count: number | null;
  avg_ticket: number | null;
  last_seen_at: string | null;
};

export type PublicDataOverview = {
  counts: Record<PublicCountKey, number>;
  activity: PublicActivityPoint[];
  topLocalities: LocalitySummary[];
  topBuildings: BuildingSummary[];
  recentListings: PublicListingSummary[];
  topBrokers: PublicBrokerSummary[];
};

export type PublicActivityPoint = {
  date: string;
  messages: number;
  parsedRecords: number;
  listings: number;
};

function formatCount(value: number | null | undefined): number {
  return Number.isFinite(value ?? NaN) ? Math.max(0, Math.trunc(value ?? 0)) : 0;
}

async function countRows(table: string): Promise<number> {
  const db = getServerSupabase();
  if (!db) return 0;
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true });
  if (error) {
    console.error(`countRows(${table}) error:`, error.message);
    return 0;
  }
  return formatCount(count);
}

function priceLabel(value: number | null, unit: string | null): string {
  if (value == null) return "Price on request";
  const normalizedUnit = (unit || "").toLowerCase();
  if (normalizedUnit === "cr" || normalizedUnit === "crore" || normalizedUnit === "crores") {
    const cr = value / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(1)} Cr`;
  }
  if (normalizedUnit === "l" || normalizedUnit === "lac" || normalizedUnit === "lakh" || normalizedUnit === "lakhs") {
    const l = value / 1_00_000;
    return `₹${l % 1 === 0 ? l : l.toFixed(1)} L`;
  }
  return `₹${value.toLocaleString("en-IN")}`;
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
  const now = new Date();
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();

  const [localities, buildings, listings, activeListings, brokers, rawMessages] = await Promise.all([
    options?.localities ?? getAllLocalities(),
    options?.buildings ?? getAllBuildings(200),
    countRows("listings"),
    (async () => {
      const d = getServerSupabase();
      if (!d) return 0;
      const { count, error } = await d
        .from("listings")
        .select("id", { count: "exact", head: true })
        .gte("last_seen", thirtyDaysAgoIso);
      if (error) {
        console.error("countActiveListings error:", error.message);
        return 0;
      }
      return formatCount(count);
    })(),
    countRows("brokers"),
    countRows("raw_messages"),
  ]);

  const topBuildings = [...buildings]
    .sort((a, b) => b.listingCount - a.listingCount || a.name.localeCompare(b.name))
    .slice(0, 8);

  const recentListings: PublicListingSummary[] = [];
  const topBrokers: PublicBrokerSummary[] = [];
  const activity: PublicActivityPoint[] = [];
  const days = 14;

  if (db) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (days - 1));
    const cutoffIso = cutoff.toISOString();
    const [recentRes, brokerRes] = await Promise.all([
      db
        .from("listings")
        .select(
          "id, bhk, price, price_unit, furnishing, location_label, building_name, landmark_name, micro_market, broker_name, broker_phone, observation_count, last_seen",
        )
        .order("last_seen", { ascending: false })
        .limit(12),
      db
        .from("brokers")
        .select(
          "canonical_name, primary_phone, observation_count, listing_count, requirement_count, market_count, avg_ticket, last_seen_at",
        )
        .order("observation_count", { ascending: false })
        .limit(8),
    ]);

    const [rawRowsRes, parsedRowsRes, listingRowsRes] = await Promise.all([
      db.from("raw_messages").select("created_at").gte("created_at", cutoffIso),
      db.from("parsed_output").select("created_at").gte("created_at", cutoffIso),
      db.from("listings").select("created_at").gte("created_at", cutoffIso),
    ]);

    if (!recentRes.error) {
      for (const row of recentRes.data ?? []) {
        recentListings.push(row as PublicListingSummary);
      }
    }
    if (!brokerRes.error) {
      for (const row of brokerRes.data ?? []) {
        topBrokers.push(row as PublicBrokerSummary);
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
    activity,
    topLocalities: localities.slice(0, 8),
    topBuildings,
    recentListings,
    topBrokers,
  };
}
