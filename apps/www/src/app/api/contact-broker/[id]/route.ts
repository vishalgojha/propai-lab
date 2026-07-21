import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { getSiteUrl } from "@/lib/site";
import { buildListingSlug } from "@/lib/listing-card";

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
  parts.push(`Hi, I came across ${subject} on PropAI — ${listingUrl} — and I'm interested.`);
  parts.push("Could you please share availability, price details and photos?");
  return parts.join(" ");
}

export async function GET(
  _req: NextRequest,
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

  const { data, error } = await db
    .from("listings")
    .select("id, bhk, micro_market, building_name, property_type, broker_phone")
    .eq("id", listingId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ available: false, reason: "not_found" }, { status: 404 });
  }
  if (!data.broker_phone) {
    return NextResponse.json({ available: false, reason: "no_phone" }, { status: 410 });
  }

  const digits = String(data.broker_phone).replace(/\D/g, "");
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  if (local.length !== 10) {
    return NextResponse.json({ available: false, reason: "bad_phone" }, { status: 410 });
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
  const canonicalPath = `/listings/${slug ?? data.id}`;

  const text = encodeURIComponent(buildRecallMessage(data, listingId, canonicalPath));
  return NextResponse.redirect(new URL(`https://wa.me/91${local}?text=${text}`), { status: 302 });
}

