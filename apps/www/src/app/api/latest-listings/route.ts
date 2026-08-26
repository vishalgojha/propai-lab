import { NextResponse } from "next/server";
import { getPublicDataOverview } from "@/lib/public-data";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(12, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "6", 10) || 6));
  const overview = await getPublicDataOverview({
    skipBuildingScan: true,
    skipCounts: true,
    skipLocalities: true,
    skipActivity: true,
  });
  const listings = overview.recentListings
    .slice(offset, offset + limit)
    .map(({ broker_phone: _phone, source_text: _source, ...listing }) => listing);
  return NextResponse.json({
    listings,
    hasMore: offset + limit < overview.recentListings.length,
  }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" } });
}
