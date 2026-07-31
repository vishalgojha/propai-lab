"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Gauge, Database, RefreshCw, AlertTriangle } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface ExtractionProgress {
  total_raw_messages: number;
  unprocessed: number;
  processed: number;
  stuck: number;
  extraction_cache_rows: number;
  processed_recent_24h: number;
  rate_window_hours: number;
  ai_calls: number;
  est_cost_usd: number;
  percent_drained: number;
}

function fmtUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

export default function AdminExtractionProgressPage() {
  const [data, setData] = useState<ExtractionProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchJSON<ExtractionProgress>("/admin/extraction-progress?hours=24");
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-zinc-400 hover:text-white">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Gauge className="w-6 h-6 text-emerald-400" />
              Extraction Progress
            </h1>
            <p className="text-sm text-zinc-500">How much backlog work has been done. Super admin view.</p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="flex items-center gap-1 px-3 py-2 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20 border border-emerald-400/30 rounded-lg text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {loading && !data ? (
        <div className="text-center py-12 text-zinc-500">Loading…</div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300">{error}</div>
      ) : data ? (
        <>
          {/* Drain gauge */}
          <section className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5 mb-8">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
              <Gauge className="w-4 h-4 text-emerald-400" />
              Backlog Drain
            </h2>
            <div className="flex items-center gap-6">
              <div className="text-center">
                <div className="text-4xl font-bold text-white">{data.percent_drained.toFixed(2)}%</div>
                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mt-1">drained</div>
              </div>
              <div className="flex-1">
                <div className="h-3 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-400 transition-all"
                    style={{ width: `${Math.min(data.percent_drained, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-zinc-500 mt-1">
                  <span>{data.processed.toLocaleString()} processed</span>
                  <span>{data.unprocessed.toLocaleString()} remaining</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-3">
              Note: not every remaining message needs an AI call — chatter / media-placeholder / too-short
              messages are skipped deterministically, and identical texts hit the extraction cache.
            </p>
          </section>

          {/* Headline numbers */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Total Messages</div>
              <div className="text-2xl font-bold text-white">{data.total_raw_messages.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">raw_messages backlog source</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Remaining</div>
              <div className="text-2xl font-bold text-amber-300">{data.unprocessed.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">processed=false</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Processed / 24h</div>
              <div className="text-2xl font-bold text-white">{data.processed_recent_24h.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">rate over last 24 hours</div>
            </div>
            <div className={`rounded-2xl border p-5 ${data.stuck > 0 ? "border-red-500/30 bg-red-500/5" : "border-white/10 bg-zinc-900/50"}`}>
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1">
                {data.stuck > 0 && <AlertTriangle className="w-3 h-3 text-red-400" />}
                Stuck Rows
              </div>
              <div className={`text-2xl font-bold ${data.stuck > 0 ? "text-red-300" : "text-white"}`}>{data.stuck}</div>
              <div className="text-xs text-zinc-400 mt-1">processed=false but processed_at set</div>
            </div>
          </div>

          {/* Cache + cost */}
          <div className="grid gap-4 sm:grid-cols-2 mb-8">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1">
                <Database className="w-3 h-3 text-cyan-400" />
                Extraction Cache
              </div>
              <div className="text-2xl font-bold text-white">{data.extraction_cache_rows.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">
                identical texts skip AI entirely; as this grows, deterministic template mining replaces AI
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">AI Calls (est.)</div>
              <div className="text-2xl font-bold text-white">{data.ai_calls.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">
                {fmtUsd(data.est_cost_usd)} internal estimate — not an external bill
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
