import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const ADMIN_EMAIL = "vishal@chaoscraftlabs.com";

// Server-side gate: only the owner may read public-site analytics.
async function isAuthorized(req: NextRequest): Promise<boolean> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return false;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) return false;
  return data.user.email === ADMIN_EMAIL;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const days = Math.min(Math.max(parseInt(searchParams.get("days") || "14", 10) || 14, 1), 90);

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from("web_analytics")
    .select("event, asset, query, visitor_id, created_at")
    .gte("created_at", since);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = data || [];

  const byEvent: Record<string, number> = {};
  const byAsset: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  const queryCounts: Record<string, number> = {};
  const visitors = new Set<string>();
  const dailyUnique: Record<string, Set<string>> = {};

  for (const r of rows) {
    const event = r.event as string;
    byEvent[event] = (byEvent[event] || 0) + 1;
    visitors.add(r.visitor_id as string);

    const day = (r.created_at as string).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    if (!dailyUnique[day]) dailyUnique[day] = new Set();
    dailyUnique[day].add(r.visitor_id as string);

    if (r.asset) {
      const asset = r.asset as string;
      byAsset[asset] = (byAsset[asset] || 0) + 1;
    }
    if (r.query && (event === "search" || event === "listing_view")) {
      const q = String(r.query).trim().toLowerCase();
      if (q) queryCounts[q] = (queryCounts[q] || 0) + 1;
    }
  }

  const topQueries = Object.entries(queryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([query, count]) => ({ query, count }));

  const daily = Object.keys(byDay)
    .sort()
    .map((day) => ({ day, events: byDay[day], visitors: dailyUnique[day]?.size || 0 }));

  return NextResponse.json({
    windowDays: days,
    totalEvents: rows.length,
    uniqueVisitors: visitors.size,
    byEvent,
    byAsset,
    daily,
    topQueries,
  });
}
