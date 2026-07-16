import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";
import { parseNaturalSearchQuery } from "@/lib/natural-search";

export const dynamic = "force-dynamic";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const query = clean((payload as Record<string, unknown>).query);
  const timeline = clean((payload as Record<string, unknown>).timeline);
  const name = clean((payload as Record<string, unknown>).name) || "Website requirement";
  const phone = clean((payload as Record<string, unknown>).phone);
  const email = clean((payload as Record<string, unknown>).email);
  const contactMe = Boolean((payload as Record<string, unknown>).contact_me);
  const shareWithBroker = Boolean((payload as Record<string, unknown>).share_with_broker);

  if (!query) {
    return NextResponse.json({ error: "query_required" }, { status: 400 });
  }
  if (!timeline) {
    return NextResponse.json({ error: "timeline_required" }, { status: 400 });
  }
  if (!contactMe && !shareWithBroker) {
    return NextResponse.json({ error: "follow_up_preference_required" }, { status: 400 });
  }
  if (contactMe && !phone && !email) {
    return NextResponse.json({ error: "contact_details_required" }, { status: 400 });
  }

  const db = getServerSupabase();
  if (!db) {
    return NextResponse.json({ error: "database_unavailable" }, { status: 503 });
  }

  const parsed = await parseNaturalSearchQuery(query);
  const notes = [
    "Captured from www no-results flow.",
    `Query: ${query}`,
    `Timeline: ${timeline}`,
    `Follow-up preference: ${contactMe ? "contact me" : ""}${contactMe && shareWithBroker ? " + " : ""}${shareWithBroker ? "share with broker" : ""}`,
    phone ? `Phone: ${phone}` : "",
    email ? `Email: ${email}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { data: clientRow, error: clientError } = await db
    .from("clients")
    .insert({
      name,
      phone: phone || null,
      email: email || null,
      notes,
    })
    .select("id")
    .single();

  if (clientError || !clientRow) {
    return NextResponse.json(
      { error: clientError?.message || "client_create_failed" },
      { status: 500 },
    );
  }

  const requirementData = {
    client_id: clientRow.id,
    intent: parsed.intent === "rent" ? "RENT" : "BUY",
    bhk: parsed.bhk == null ? null : parsed.bhk === 0 ? "Studio" : `${parsed.bhk} BHK`,
    price_min: parsed.minPrice,
    price_max: parsed.maxPrice,
    micro_market: parsed.locality,
    furnishing: parsed.furnishing,
    notes,
  };

  const { data: requirementRow, error: requirementError } = await db
    .from("client_requirements")
    .insert(requirementData)
    .select("id")
    .single();

  if (requirementError || !requirementRow) {
    return NextResponse.json(
      { error: requirementError?.message || "requirement_create_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    client_id: clientRow.id,
    requirement_id: requirementRow.id,
  });
}
