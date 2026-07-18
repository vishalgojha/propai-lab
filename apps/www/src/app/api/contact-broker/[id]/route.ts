import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";

// Resolves the broker phone server-side from the listing id and 302-redirects
// to the wa.me deep link with a pre-filled recall message. The raw phone number
// is NEVER placed in public HTML (DPDP Act 2023 — phone is sensitive personal
// data), so it is not crawlable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildRecallMessage(row: {
  property_type?: string | null;
  asset_type?: string | null;
  micro_market?: string | null;
  building_name?: string | null;
  bhk?: string | null;
}): string {
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

  parts.push(`Hi, I came across ${subject} on PropAI and I'm interested.`);
  parts.push("Could you please share availability, price details and photos?");
  return parts.join(" ");
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const listingId = Number.parseInt(id, 10);
  if (!Number.isFinite(listingId)) {
    return NextResponse.redirect(new URL("/", _req.url), { status: 302 });
  }

  const db = getServerSupabase();
  if (!db) {
    return NextResponse.redirect(new URL("/", _req.url), { status: 302 });
  }

  const { data, error } = await db
    .from("listings")
    .select("broker_phone, property_type, asset_type, micro_market, building_name, bhk")
    .eq("id", listingId)
    .maybeSingle();

  if (error || !data?.broker_phone) {
    return NextResponse.redirect(new URL("/", _req.url), { status: 302 });
  }

  const digits = String(data.broker_phone).replace(/\D/g, "");
  const local = digits.endsWith("91") && digits.length > 10 ? digits.slice(-10) : digits.slice(-10);
  if (local.length !== 10) {
    return NextResponse.redirect(new URL("/", _req.url), { status: 302 });
  }

  const text = encodeURIComponent(buildRecallMessage(data));
  return NextResponse.redirect(new URL(`https://wa.me/91${local}?text=${text}`), { status: 302 });
}
