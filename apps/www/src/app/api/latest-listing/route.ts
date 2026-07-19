import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";

// Lightweight endpoint powering the homepage "Just landed" ticker.
// Returns the single most-recently-seen listing (sanitized), server-side
// via the service-role client so the anon web key is never exposed.
export const dynamic = "force-dynamic";
export const revalidate = 0;

const FIELDS = [
  "id",
  "bhk",
  "price",
  "price_unit",
  "furnishing",
  "asset_type",
  "transaction_type",
  "building_name",
  "micro_market",
      "location_label",
  "broker_name",
  "last_seen",
  "created_at",
].join(", ");

export async function GET() {
  const db = getServerSupabase();
  if (!db) {
    return NextResponse.json({ listing: null }, { status: 200 });
  }
  try {
    const { data, error } = (await db
      .from("listings")
      .select(FIELDS)
      .order("last_seen", { ascending: false })
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null; error: unknown };

    if (error || !data) {
      return NextResponse.json({ listing: null }, { status: 200 });
    }

    const d = data as Record<string, unknown>;
    const listing = {
      id: d.id as number,
      bhk: (d.bhk as string) ?? null,
      price: typeof d.price === "number" ? d.price : null,
      priceUnit: (d.price_unit as string) ?? null,
      furnishing: (d.furnishing as string) ?? null,
      assetType: (d.asset_type as string) ?? null,
      transactionType: (d.transaction_type as string) ?? null,
      building: (d.building_name as string) ?? null,
      microMarket: (d.micro_market as string) ?? null,
      locality: ((d.location_label as string) ?? (d.micro_market as string)) ?? null,
      broker: (d.broker_name as string) ?? null,
      lastSeen: ((d.last_seen as string) ?? (d.created_at as string)) ?? null,
    };

    return NextResponse.json({ listing }, { status: 200 });
  } catch {
    return NextResponse.json({ listing: null }, { status: 200 });
  }
}
