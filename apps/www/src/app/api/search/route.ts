import { NextResponse } from "next/server";
import { searchNaturalLanguageListings, describeNaturalSearch } from "@/lib/natural-search";
import { toListingCardViewModel } from "@/lib/listing-card";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") || "").slice(0, 300).trim();
  const assetParam = (searchParams.get("asset") || "").toLowerCase();
  const asset =
    assetParam === "residential" || assetParam === "commercial" ? assetParam : null;

  const state = await searchNaturalLanguageListings(q, 24, asset);
  const summary = state.parsed ? describeNaturalSearch(state.parsed) : "";

  const results = state.results.map((row) => {
    const card = toListingCardViewModel(row, row.resultType === "building");
    return {
      card,
      buildingName: row.building_name,
      footerNote:
        row.matchedOn && row.matchedOn.length > 0
          ? `Matched on: ${row.matchedOn.join(", ")}`
          : null,
    };
  });

  return NextResponse.json({
    query: q,
    asset,
    summary,
    results,
    locality: state.parsed?.locality ?? null,
    localitySlug: state.parsed?.locality
      ? // slugify is a pure function; import lazily to avoid heavy deps
        (await import("@/lib/supabase")).slugify(state.parsed.locality)
      : null,
    localityUnmatched: state.localityUnmatched,
    localitySuggestions: state.localitySuggestions,
  });
}
