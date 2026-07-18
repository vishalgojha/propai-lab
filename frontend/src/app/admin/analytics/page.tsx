"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface AnalyticsData {
  windowDays: number;
  totalEvents: number;
  uniqueVisitors: number;
  byEvent: Record<string, number>;
  byAsset: Record<string, number>;
  daily: { day: string; events: number; visitors: number }[];
  topQueries: { query: string; count: number }[];
}

const EVENT_LABELS: Record<string, string> = {
  search: "Searches",
  listing_view: "Listing views",
  contact_click: "Contact clicks",
  shortlist: "Shortlist adds",
  bundle_send: "Bundle sends",
};

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-5">
      <div className="text-3xl font-bold text-white">{value}</div>
      <div className="mt-1 text-xs text-zinc-400">{label}</div>
    </div>
  );
}

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-40 shrink-0 truncate text-xs text-zinc-400">{label}</div>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full bg-[#3EE88A]" style={{ width: `${pct}%` }} />
      </div>
      <div className="w-12 shrink-0 text-right text-xs font-semibold text-white">{value}</div>
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(14);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJSON<AnalyticsData>(`/admin/analytics?days=${days}`);
      setData(res);
    } catch (e: any) {
      setError(e?.message || "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxEvent = data ? Math.max(...Object.values(data.byEvent), 1) : 1;
  const maxAsset = data ? Math.max(...Object.values(data.byAsset), 1) : 1;
  const maxDaily = data ? Math.max(...data.daily.map((d) => d.events), 1) : 1;
  const maxQuery = data?.topQueries.length ? Math.max(...data.topQueries.map((q) => q.count), 1) : 1;

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Link href="/admin" className="text-zinc-400 hover:text-white" aria-label="Back">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <div>
              <h1 className="flex items-center gap-2 text-xl font-bold">
                <BarChart3 className="h-5 w-5 text-[#3EE88A]" />
                Public Site Analytics
              </h1>
              <p className="mt-0.5 text-sm text-zinc-500">
                Anonymous activity from www.propai.live (searches, views, contact clicks).
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-900/60 p-1">
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  days === d ? "bg-white/10 text-white" : "text-zinc-400 hover:text-white"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {loading && <div className="py-20 text-center text-sm text-zinc-500">Loading analytics…</div>}
        {error && <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">{error}</div>}

        {data && !loading && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <StatCard label="Total events" value={data.totalEvents} />
              <StatCard label="Unique visitors" value={data.uniqueVisitors} />
              <StatCard label="Window" value={`${data.windowDays} days`} />
            </div>

            <section className="rounded-xl border border-white/10 bg-zinc-900/30 p-5">
              <h2 className="mb-3 text-sm font-semibold text-white">Events by type</h2>
              {Object.keys(data.byEvent).length === 0 ? (
                <p className="text-xs text-zinc-500">No events in this window.</p>
              ) : (
                Object.entries(data.byEvent).map(([event, value]) => (
                  <BarRow key={event} label={EVENT_LABELS[event] || event} value={value} max={maxEvent} />
                ))
              )}
            </section>

            {Object.keys(data.byAsset).length > 0 && (
              <section className="rounded-xl border border-white/10 bg-zinc-900/30 p-5">
                <h2 className="mb-3 text-sm font-semibold text-white">Residential vs Commercial</h2>
                {Object.entries(data.byAsset).map(([asset, value]) => (
                  <BarRow key={asset} label={asset === "commercial" ? "Commercial" : asset === "residential" ? "Residential" : asset} value={value} max={maxAsset} />
                ))}
              </section>
            )}

            <section className="rounded-xl border border-white/10 bg-zinc-900/30 p-5">
              <h2 className="mb-3 text-sm font-semibold text-white">Daily activity</h2>
              <div className="space-y-1">
                {data.daily.map((d) => (
                  <BarRow key={d.day} label={d.day} value={d.events} max={maxDaily} />
                ))}
              </div>
            </section>

            {data.topQueries.length > 0 && (
              <section className="rounded-xl border border-white/10 bg-zinc-900/30 p-5">
                <h2 className="mb-3 text-sm font-semibold text-white">Top searches</h2>
                {data.topQueries.map((q) => (
                  <BarRow key={q.query} label={q.query} value={q.count} max={maxQuery} />
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
