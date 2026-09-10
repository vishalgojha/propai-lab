import { getServerSupabase, slugify } from "./supabase";
import { buildListingSlug, normalizeBhkFromEvidence } from "./listing-card";
import { formatPublicPrice } from "./public-data";

export type PublicCollection = {
  id: number;
  slug: string;
  title: string;
  description: string;
  locality: string;
  transactionType: "rent" | "sale";
  bhk: string | null;
  listingCount: number;
  freshnessDays: number;
  generatedAt: string;
  updatedAt: string;
};

export type PublicCollectionListing = {
  id: number;
  cardType: string;
  rank: number;
  score: number;
  reasonCodes: string[];
  title: string;
  href: string;
  buildingName: string | null;
  locality: string | null;
  bhk: string | null;
  priceLabel: string;
  furnishing: string | null;
  areaSqft: number | null;
  lastSeen: string | null;
};

function mapCollection(row: Record<string, unknown>): PublicCollection {
  return {
    id: Number(row.id), slug: String(row.slug), title: String(row.title), description: String(row.description),
    locality: String(row.locality), transactionType: row.transaction_type === "sale" ? "sale" : "rent",
    bhk: row.bhk == null ? null : String(row.bhk), listingCount: Number(row.listing_count ?? 0),
    freshnessDays: Number(row.freshness_days ?? 30), generatedAt: String(row.generated_at), updatedAt: String(row.updated_at),
  };
}

export async function getPublicCollections(): Promise<PublicCollection[]> {
  const db = getServerSupabase();
  if (!db) return [];
  const { data, error } = await db.from("public_listing_collections_public").select("*").order("updated_at", { ascending: false }).limit(100);
  if (error) {
    console.error("public collections query error:", error.message);
    return [];
  }
  return (data ?? []).map((row) => mapCollection(row as Record<string, unknown>));
}

export async function getPublicCollection(slug: string): Promise<{ collection: PublicCollection; listings: PublicCollectionListing[] } | null> {
  const db = getServerSupabase();
  if (!db) return null;
  const { data: collectionRow, error: collectionError } = await db.from("public_listing_collections_public").select("*").eq("slug", slug).limit(1).maybeSingle();
  if (collectionError || !collectionRow) return null;
  const collection = mapCollection(collectionRow as Record<string, unknown>);
  const { data: items, error: itemError } = await db.from("public_listing_collection_items_public").select("listing_type, listing_id, rank, score, reason_codes").eq("slug", slug).order("rank", { ascending: true }).limit(24);
  if (itemError) return { collection, listings: [] };

  const rows: PublicCollectionListing[] = [];
  for (const type of ["residential_rent", "residential_sale", "commercial_rent", "commercial_sale"]) {
    const ids = (items ?? []).filter((item) => item.listing_type === type).map((item) => Number(item.listing_id)).filter(Number.isFinite);
    if (!ids.length) continue;
    const { data: listings } = await db.from("listings_unified_public").select("card_type, id, summary_title, building_name, micro_market, bhk, price, price_unit, intent, furnishing, area_sqft, last_seen, price_raw_text, property_type, locality_resolved").eq("card_type", type).in("id", ids);
    const byId = new Map((listings ?? []).map((row) => [Number(row.id), row]));
    for (const item of (items ?? []).filter((entry) => entry.listing_type === type)) {
      const row = byId.get(Number(item.listing_id));
      if (!row) continue;
      const title = String(row.summary_title || `${row.bhk || "Property"} for ${collection.transactionType} in ${row.micro_market || collection.locality}`).trim();
      const hrefSlug = buildListingSlug({ id: Number(row.id), bhk: row.bhk, micro_market: row.micro_market, building_name: row.building_name, property_type: row.property_type, intent: row.intent, title });
      if (!hrefSlug) continue;
      rows.push({
        id: Number(row.id), cardType: type, rank: Number(item.rank), score: Number(item.score ?? 0), reasonCodes: Array.isArray(item.reason_codes) ? item.reason_codes.map(String) : [],
        title, href: `/listings/${hrefSlug}/${row.id}`, buildingName: row.building_name || null, locality: row.micro_market || row.locality_resolved || null,
        bhk: normalizeBhkFromEvidence(row.bhk, title), priceLabel: formatPublicPrice(row.price == null ? null : Number(row.price), row.price_unit, row.intent, row.price_raw_text),
        furnishing: row.furnishing || null, areaSqft: row.area_sqft == null ? null : Number(row.area_sqft), lastSeen: row.last_seen || null,
      });
    }
  }
  rows.sort((a, b) => a.rank - b.rank);
  return { collection, listings: rows };
}
