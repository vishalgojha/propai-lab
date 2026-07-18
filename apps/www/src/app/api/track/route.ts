import { NextRequest, NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase";

// Receives anonymous analytics events from the public site. No auth, no PII —
// the visitor is identified only by an anonymous cookie id set client-side.
// Events: listing_view, search, contact_click, shortlist_add, shortlist_remove,
// bundle_send, page_view.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_EVENTS = new Set([
  "page_view",
  "listing_view",
  "search",
  "contact_click",
  "shortlist_add",
  "shortlist_remove",
  "bundle_send",
]);

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  const {
    visitor_id,
    event,
    listing_id,
    query,
    asset,
    page,
    extra,
  } = payload as Record<string, unknown>;

  if (typeof visitor_id !== "string" || !visitor_id) {
    return NextResponse.json({ ok: false, error: "visitor_required" }, { status: 400 });
  }
  if (typeof event !== "string" || !ALLOWED_EVENTS.has(event)) {
    return NextResponse.json({ ok: false, error: "bad_event" }, { status: 400 });
  }

  const db = getServerSupabase();
  if (!db) {
    // Analytics must never break the page — fail silently.
    return NextResponse.json({ ok: true, stored: false });
  }

  const row: Record<string, unknown> = {
    visitor_id: visitor_id.slice(0, 128),
    event,
    page: typeof page === "string" ? page.slice(0, 256) : null,
    listing_id: typeof listing_id === "number" ? listing_id : null,
    query: typeof query === "string" ? query.slice(0, 512) : null,
    asset: typeof asset === "string" ? asset.slice(0, 32) : null,
    payload:
      extra && typeof extra === "object"
        ? (extra as object)
        : {},
  };

  const { error } = await db.from("web_analytics").insert(row);
  if (error) {
    return NextResponse.json({ ok: true, stored: false });
  }
  return NextResponse.json({ ok: true, stored: true });
}

// GET lets the client verify the endpoint is alive (used for a no-op health
// check) without sending data.
export async function GET() {
  return NextResponse.json({ ok: true });
}
