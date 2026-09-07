import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { getSiteUrl } from "@/lib/site";
import { buildListingSlug, inferBhkFromText } from "@/lib/listing-card";

// Resolves the broker phone server-side from the listing id and 302-redirects
// to the wa.me deep link with a pre-filled recall message. The raw phone number
// is NEVER placed in public HTML (DPDP Act 2023 — phone is sensitive personal
// data), so it is not crawlable.
//
// When broker_phone is missing or malformed we return 410 Gone with a
// structured JSON body instead of silently 302-ing back to the listing page
// (the old behaviour looked like a broken CTA). The frontend reads the
// listing-card VM (waAvailable) to decide whether to render the button at all.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildRecallMessage(
  row: {
    property_type?: string | null;
    asset_type?: string | null;
    micro_market?: string | null;
    building_name?: string | null;
    bhk?: string | null;
    source_message?: string | null;
  },
  listingId: number,
  canonicalPath: string,
): string {
  const parts: string[] = [];
  const ptype = (row.property_type || row.asset_type || "").trim();
  const locality = (row.micro_market || "").trim();
  const building = (row.building_name || "").trim();
  const bhk = (row.bhk || "").trim();

  let subject = "your listing";
  if (ptype) subject = ptype.charAt(0).toUpperCase() + ptype.slice(1);
  if (bhk) subject = `${bhk} ${subject}`;
  if (building && !/^(sq\.?\s*ft|multiple options|carpet|na\b)/i.test(building)) {
    subject += ` at ${building}`;
  } else if (locality) {
    subject += ` in ${locality}`;
  }

  const listingUrl = `https://www.propai.live${canonicalPath}`;
  parts.push(`Hi, I came across this listing on PropAI — ${listingUrl} — and I'm interested.`);
  // This route is for one listing, so preserve its normalized single-item
  // source slice as the recall context. It contains the broker's actual facts
  // (BHK, locality, rent, furnishing, etc.) instead of a lossy generic prompt.
  // Bulk broadcasts are not passed here: parsed_output_unified is scoped by
  // representative listing_index below.
  const source = String(row.source_message || "").trim();
  if (source) parts.push(`Listing details:\n${source}`);
  parts.push("Please confirm availability and share any updated price or photos.");
  return parts.join(" ");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const listingId = Number.parseInt(id, 10);
  const siteUrl = getSiteUrl();
  if (!Number.isFinite(listingId)) {
    return NextResponse.json({ available: false, reason: "bad_id" }, { status: 410 });
  }

  const db = getServerSupabase();
  if (!db) {
    // Treat no-DB as a configuration error rather than a missing phone — the
    // caller should retry / report rather than assume the broker has no phone.
    return NextResponse.json({ available: false, reason: "no_db" }, { status: 503 });
  }

  const requestedSlug = req.nextUrl.searchParams.get("slug");
  const requestedCardType = req.nextUrl.searchParams.get("card_type");
  const { data: candidates, error } = await db
    .from("listings_unified_public")
    .select("id, card_type, bhk, micro_market, building_name, property_type, intent, opportunity_key")
    .eq("id", listingId)
    .limit(25);

  if (error || !candidates?.length) {
    return NextResponse.json({ available: false, reason: "not_found" }, { status: 404 });
  }
  const typedCandidates = requestedCardType
    ? candidates.filter((candidate) => candidate.card_type === requestedCardType)
    : candidates;
  const matching = requestedSlug
    ? typedCandidates.filter((candidate) => buildListingSlug({
        id: Number(candidate.id),
        bhk: candidate.bhk,
        micro_market: candidate.micro_market,
        building_name: candidate.building_name,
        property_type: candidate.property_type,
        intent: candidate.intent,
      }) === requestedSlug)
    : typedCandidates;
  // Numeric IDs are not globally unique across the UNION view's typed-table
  // sequences. Never contact an arbitrary broker when the URL did not carry
  // enough identity to select exactly one listing.
  if (matching.length !== 1) {
    return NextResponse.json({ available: false, reason: "ambiguous_listing" }, { status: 409 });
  }
  const data = matching[0];
  const typedTableByCard: Record<string, string> = {
    residential_sale: "residential_sale_listings",
    residential_rent: "residential_rent_listings",
    commercial_sale: "commercial_sale_listings",
    commercial_rent: "commercial_rent_listings",
  };
  const typedTable = typedTableByCard[String(data.card_type || "")];
  if (!typedTable) {
    return NextResponse.json({ available: false, reason: "unknown_listing_type" }, { status: 410 });
  }
  const { data: privateRow } = await db
    .from(typedTable)
    .select("broker_phone, raw_message_id, listing_index")
    .eq("id", listingId)
    .maybeSingle();
  const brokerPhone = privateRow?.broker_phone;
  if (!brokerPhone) {
    return NextResponse.json({ available: false, reason: "no_phone" }, { status: 410 });
  }

  const digits = String(brokerPhone).replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10) {
    return NextResponse.json({ available: false, reason: "bad_phone" }, { status: 410 });
  }

  let sourceMessage: string | null = null;
  const sourceId = privateRow.raw_message_id;
  if (sourceId != null) {
    const { data: parsed } = await db
      .from("parsed_output_unified")
      .select("normalized_message")
      .eq("raw_message_id", sourceId)
      .eq("listing_index", privateRow.listing_index ?? 0)
      .maybeSingle();
    sourceMessage = parsed?.normalized_message ?? null;
  }

  // Build the canonical public URL (with SEO slug) so the WhatsApp recall
  // message contains the same URL Google has indexed.
  const slug = buildListingSlug({
    id: data.id,
    bhk: data.bhk,
    micro_market: data.micro_market,
    building_name: data.building_name,
    property_type: data.property_type,
  });
  const canonicalPath = `/listings/${slug ?? "listing"}/${data.id}`;

  const target = new URL(`https://wa.me/91${local}`);
  target.searchParams.set("text", buildRecallMessage(data, listingId, canonicalPath));
  return NextResponse.redirect(target, { status: 302 });
}
