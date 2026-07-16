import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";

// Resolves the broker phone server-side from the listing id and 302-redirects
// to the wa.me deep link. The raw phone number is NEVER placed in public HTML
// (DPDP Act 2023 — phone is sensitive personal data), so it is not crawlable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    .select("broker_phone")
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

  return NextResponse.redirect(new URL(`https://wa.me/91${local}`), { status: 302 });
}
