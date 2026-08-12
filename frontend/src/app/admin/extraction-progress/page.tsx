"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Gauge, Database, RefreshCw, AlertTriangle } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface ExtractionProgress {
  total_raw_messages: number;
  unprocessed?: number;
  pending?: number;
  processed: number;
  stuck?: number;
  extraction_cache_rows: number;
  processed_recent_24h?: number;
  rate_window_hours: number;
  ai_calls?: number;
  est_cost_usd?: number;
  percent_drained?: number;
  progress_pct?: number;
  recently_processed?: number;
  processed_recent?: number;
  tenant_breakdown?: Array<{
    tenant_id: string;
    organization_name: string;
    total_raw_messages: number;
    processed: number;
    unprocessed: number;
    stuck: number;
    processed_recent: number;
    percent_drained: number;
  }>;
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
      // Keep this page tenant-scoped. The old admin endpoint queried the
      // global progress breakdown and timed out on the production backlog.
      // This is an exact count over the workspace raw-message ledger. Under
      // load it can outlive the normal interactive API timeout, so let the
      // admin page wait rather than displaying a misleading 503 state.
      const res = await fetchJSON<ExtractionProgress>("/extraction/progress?hours=24", undefined, 60000);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const progressPercent = data?.percent_drained ?? data?.progress_pct ?? 0;
  const pending = data?.unprocessed ?? data?.pending ?? 0;
  const recentlyProcessed = data?.processed_recent ?? data?.recently_processed ?? data?.processed_recent_24h ?? 0;

  return (
    <div className="mx-auto max-w-6xl p-3 sm:p-7">
      <div className="mb-4 flex items-center justify-between gap-3 sm:mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-zinc-400 hover:text-white">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <p className="propai-kicker text-[10px] font-semibold">Pipeline telemetry</p>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-[-0.03em] text-white sm:text-3xl">
              <Gauge className="w-6 h-6 text-emerald-400" />
              Extraction Progress
            </h1>
            <p className="text-sm text-zinc-500">How much of your workspace extraction backlog has been processed.</p>
          </div>
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2 text-xs text-emerald-300 hover:bg-emerald-400/20 sm:h-9 sm:px-3 sm:text-sm"
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
            <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:gap-6">
              <div className="text-center">
                <div className="text-4xl font-bold text-white">{progressPercent.toFixed(2)}%</div>
                <div className="text-[11px] text-zinc-500 uppercase tracking-wider mt-1">drained</div>
              </div>
              <div className="flex-1">
                <div className="h-3 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-400 transition-all"
                    style={{ width: `${Math.min(progressPercent, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-zinc-500 mt-1">
                  <span>{data.processed.toLocaleString()} processed</span>
                  <span>{pending.toLocaleString()} remaining</span>
                </div>
              </div>
            </div>
            <p className="text-xs text-zinc-500 mt-3">
              Note: not every remaining message needs an AI call — chatter / media-placeholder / too-short
              messages are skipped deterministically, and identical texts hit the extraction cache.
            </p>
          </section>

          {/* Headline numbers */}
          <div className="mb-6 grid gap-2 min-[380px]:grid-cols-2 sm:mb-8 sm:gap-4 lg:grid-cols-4">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-3 sm:p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Total Messages</div>
              <div className="break-all text-xl font-bold text-white sm:text-2xl">{data.total_raw_messages.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">raw_messages backlog source</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-3 sm:p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Remaining</div>
              <div className="break-all text-xl font-bold text-amber-300 sm:text-2xl">{pending.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">processed=false</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-3 sm:p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Processed / 24h</div>
              <div className="break-all text-xl font-bold text-white sm:text-2xl">{recentlyProcessed.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">rate over last 24 hours</div>
            </div>
            <div className={`rounded-2xl border p-3 sm:p-5 ${(data.stuck ?? 0) > 0 ? "border-red-500/30 bg-red-500/5" : "border-white/10 bg-zinc-900/50"}`}>
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1">
                {(data.stuck ?? 0) > 0 && <AlertTriangle className="w-3 h-3 text-red-400" />}
                Stuck Rows
              </div>
              <div className={`break-all text-xl font-bold sm:text-2xl ${(data.stuck ?? 0) > 0 ? "text-red-300" : "text-white"}`}>{data.stuck ?? "—"}</div>
              <div className="text-xs text-zinc-400 mt-1">processed=false but processed_at set</div>
            </div>
          </div>
          {data.tenant_breakdown && data.tenant_breakdown.length > 0 && (
            <section className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5 mb-8">
              <h2 className="text-sm font-semibold text-white mb-4">All extraction pipelines</h2>
              <div className="space-y-2">
                {data.tenant_breakdown.map((pipeline) => (
                  <div key={pipeline.tenant_id} className="grid gap-1 rounded-lg border border-white/5 px-3 py-2 text-xs min-[520px]:grid-cols-[minmax(0,1fr)_auto_auto_auto] min-[520px]:items-center min-[520px]:gap-4">
                    <span className="truncate text-zinc-200">{pipeline.organization_name}</span>
                    <span className="text-zinc-400">{pipeline.total_raw_messages.toLocaleString()} messages</span>
                    <span className="text-zinc-400">{pipeline.processed_recent.toLocaleString()} / 24h</span>
                    <span className={pipeline.unprocessed > 0 ? "text-amber-300" : "text-emerald-300"}>{pipeline.unprocessed.toLocaleString()} remaining</span>
                  </div>
                ))}
              </div>
            </section>
          )}

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
              <div className="text-2xl font-bold text-white">{data.ai_calls != null ? data.ai_calls.toLocaleString() : "—"}</div>
              <div className="text-xs text-zinc-400 mt-1">
                {data.est_cost_usd != null ? `${fmtUsd(data.est_cost_usd)} internal estimate — not an external bill` : "Workspace cost is shown in the AI usage view"}
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
