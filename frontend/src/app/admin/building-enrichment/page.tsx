"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock3, ExternalLink, MapPin, RefreshCw, Search, Server, TriangleAlert, XCircle } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type WorkerEvidence = {
  worker: {
    worker_name: string;
    service_name: string;
    status: string;
    heartbeat_at: string | null;
    started_at?: string | null;
    last_error?: string | null;
    runtime_version?: string | null;
    config?: Record<string, unknown>;
  };
  queue: { pending: number; running: number; completed: number; failed: number; total: number };
  latest_success_at: string | null;
  latest_failure: {
    id: number;
    provider: string;
    last_error: string | null;
    attempts: number;
    updated_at: string | null;
    building_code: string | null;
    canonical_name: string | null;
  } | null;
  recent_jobs: Array<{
    id: number;
    status: string;
    provider: string;
    attempts: number;
    last_error: string | null;
    updated_at?: string | null;
    completed_at?: string | null;
    started_at?: string | null;
    created_at?: string | null;
    building_code: string | null;
    canonical_name: string | null;
    micro_market: string | null;
  }>;
  recent_history: Array<{
    id: number;
    action: string;
    provider: string;
    confidence: number;
    created_at: string;
    building_code: string | null;
    canonical_name: string | null;
    micro_market: string | null;
  }>;
  web_search?: {
    attempts: number;
    corrections: number;
    failures: number;
    budget_exhausted: number;
  };
  recent_web_evidence?: Array<{
    id: number;
    action: string;
    confidence: number;
    details: Record<string, unknown> | null;
    created_at: string;
    building_code: string | null;
    canonical_name: string | null;
    micro_market: string | null;
  }>;
};

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function ageLabel(value: string | null | undefined): string {
  if (!value) return "No heartbeat recorded";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function workerState(worker: WorkerEvidence["worker"]): { label: string; tone: string; icon: typeof CheckCircle2 } {
  if (worker.status === "stopped") return { label: "Stopped", tone: "text-zinc-300 border-white/10 bg-white/[0.04]", icon: XCircle };
  if (!worker.heartbeat_at || Date.now() - new Date(worker.heartbeat_at).getTime() > 120000) {
    return { label: "Stale / no evidence", tone: "text-rose-200 border-rose-400/30 bg-rose-500/[0.08]", icon: TriangleAlert };
  }
  if (worker.status === "degraded") return { label: "Degraded", tone: "text-amber-100 border-amber-400/30 bg-amber-400/[0.08]", icon: TriangleAlert };
  return { label: "Alive", tone: "text-emerald-200 border-emerald-400/30 bg-emerald-400/[0.08]", icon: CheckCircle2 };
}

function Metric({ label, value, note, tone = "text-white" }: { label: string; value: string | number; note: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone}`}>{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{note}</div>
    </div>
  );
}

function detailText(details: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function BuildingEnrichmentPage() {
  const [data, setData] = useState<WorkerEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await fetchJSON<WorkerEvidence>("/admin/building-enrichment/worker", undefined, 30000));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Worker evidence could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const state = useMemo(() => data ? workerState(data.worker) : null, [data]);
  const StateIcon = state?.icon ?? Server;

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0 p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/admin" className="mt-1 text-zinc-400 hover:text-white"><ArrowLeft className="h-5 w-5" /></Link>
          <div>
            <p className="propai-kicker text-[10px] font-semibold">Platform operations</p>
            <h1 className="mt-1 flex items-center gap-3 text-3xl font-semibold tracking-[-0.035em] text-white"><MapPin className="h-7 w-7 text-amber-400" />Building Enrichment Worker</h1>
            <p className="mt-1 text-sm text-zinc-500">Observed worker heartbeat, queue state, and enrichment outcomes</p>
          </div>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-2 rounded-lg border border-cyan-400/30 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-400/10"><RefreshCw className="h-4 w-4" />Refresh</button>
      </div>

      {loading && <div className="rounded-xl border border-white/10 p-5 text-sm text-zinc-500">Loading worker evidence…</div>}
      {error && <div className="rounded-xl border border-red-400/30 bg-red-500/[0.08] p-4 text-sm text-red-200">{error}</div>}

      {data && state && (
        <>
          <section className="mb-6 rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-11 w-11 items-center justify-center rounded-xl border ${state.tone}`}><StateIcon className="h-5 w-5" /></div>
                <div>
                  <div className="text-lg font-semibold text-white">{state.label}</div>
                  <div className="text-xs text-zinc-500">{data.worker.worker_name} · service {data.worker.service_name}</div>
                </div>
              </div>
              <div className="text-right text-xs text-zinc-500">
                <div>Last heartbeat: <span className="text-zinc-300">{ageLabel(data.worker.heartbeat_at)}</span></div>
                <div>{formatTime(data.worker.heartbeat_at)}</div>
              </div>
            </div>
            <div className="mt-5 grid gap-3 border-t border-white/10 pt-4 text-xs text-zinc-500 sm:grid-cols-3">
              <div>Runtime: <span className="font-mono text-zinc-300">{data.worker.runtime_version || "unknown"}</span></div>
              <div>Last completed job: <span className="text-zinc-300">{formatTime(data.latest_success_at)}</span></div>
              <div>Config: <span className="text-zinc-300">{data.worker.config ? `${String(data.worker.config.batch_size ?? "—")} batch · ${String(data.worker.config.concurrency ?? "—")} concurrency` : "—"}</span></div>
            </div>
          </section>

          <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Pending" value={data.queue.pending} note="Waiting for worker" tone="text-amber-300" />
            <Metric label="Running" value={data.queue.running} note="Currently claimed" tone="text-cyan-300" />
            <Metric label="Completed" value={data.queue.completed} note="Successful jobs" tone="text-emerald-300" />
            <Metric label="Failed" value={data.queue.failed} note="Terminal failures" tone={data.queue.failed ? "text-rose-300" : "text-white"} />
            <Metric label="Total" value={data.queue.total} note="All enrichment jobs" />
          </section>

          <section className="mb-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.04] p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 font-semibold text-white"><Search className="h-4 w-4 text-cyan-300" />Crawl4AI web evidence</div>
                <p className="mt-1 text-xs text-zinc-500">A search attempt is recorded before Crawl4AI runs. A correction is only counted after web discovery is verified against Google Places.</p>
              </div>
              <div className={`rounded-full border px-3 py-1 text-xs ${data.worker.config?.web_search_enabled ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200" : "border-zinc-600 bg-zinc-800 text-zinc-400"}`}>
                Web search {data.worker.config?.web_search_enabled ? "enabled" : "disabled"}
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Metric label="Searches today" value={data.web_search?.attempts ?? 0} note={`of ${String(data.worker.config?.max_web_searches_per_day ?? "—")} daily cap`} tone="text-cyan-300" />
              <Metric label="Verified corrections" value={data.web_search?.corrections ?? 0} note="Alias discovered after verification" tone="text-emerald-300" />
              <Metric label="Web-stage failures" value={data.web_search?.failures ?? 0} note="Failed or retry scheduled" tone={(data.web_search?.failures ?? 0) ? "text-rose-300" : "text-white"} />
              <Metric label="Budget stops" value={data.web_search?.budget_exhausted ?? 0} note="Jobs deferred safely" tone={(data.web_search?.budget_exhausted ?? 0) ? "text-amber-300" : "text-white"} />
              <Metric label="Last web event" value={data.recent_web_evidence?.[0] ? ageLabel(data.recent_web_evidence[0].created_at) : "—"} note={data.recent_web_evidence?.[0]?.action || "No web evidence yet"} />
            </div>
            <div className="mt-5 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[850px] text-sm"><thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500"><tr className="border-b border-white/10"><th className="px-3 py-3">Building</th><th className="px-3 py-3">Event</th><th className="px-3 py-3">Resolved name</th><th className="px-3 py-3">Source</th><th className="px-3 py-3">When</th></tr></thead><tbody>
                {(data.recent_web_evidence ?? []).slice(0, 12).map((item) => {
                  const sourceUrl = detailText(item.details, "source_url");
                  const resolvedName = detailText(item.details, "resolved_name");
                  return <tr key={item.id} className="border-b border-white/5"><td className="px-3 py-3 text-zinc-200">{item.canonical_name || item.building_code || "Unknown"}<div className="text-xs text-zinc-600">{item.micro_market || "No locality"}</div></td><td className={`px-3 py-3 text-xs font-semibold ${item.action === "alias_discovered" ? "text-emerald-300" : item.action.includes("fail") || item.action.includes("retry") ? "text-rose-300" : "text-cyan-300"}`}>{item.action}<div className="text-zinc-600">{Math.round(Number(item.confidence || 0) * 100)}% confidence</div></td><td className="px-3 py-3 text-zinc-300">{resolvedName || "—"}</td><td className="px-3 py-3">{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan-300 hover:text-cyan-100">Open result <ExternalLink className="h-3 w-3" /></a> : <span className="text-zinc-600">—</span>}</td><td className="px-3 py-3 text-xs text-zinc-500">{ageLabel(item.created_at)}</td></tr>;
                })}
                {!data.recent_web_evidence?.length && <tr><td colSpan={5} className="px-3 py-6 text-center text-sm text-zinc-500">No Crawl4AI events recorded yet. Deploy/restart the worker, then refresh this panel.</td></tr>}
              </tbody></table>
            </div>
          </section>

          <section className="mb-6 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="mb-4 flex items-center gap-2 font-semibold text-white"><Clock3 className="h-4 w-4 text-cyan-300" />Recent job activity</div>
              <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500"><tr className="border-b border-white/10"><th className="px-2 py-3">Building</th><th className="px-2 py-3">Provider</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Updated</th></tr></thead><tbody>{data.recent_jobs.slice(0, 15).map((job) => <tr key={job.id} className="border-b border-white/5"><td className="px-2 py-3 text-zinc-200">{job.canonical_name || job.building_code || "Unknown"}<div className="text-xs text-zinc-600">{job.micro_market || "No locality"}</div></td><td className="px-2 py-3 text-xs text-zinc-400">{job.provider || "—"}</td><td className={`px-2 py-3 text-xs font-semibold uppercase ${job.status === "completed" ? "text-emerald-300" : job.status === "failed" ? "text-rose-300" : job.status === "running" ? "text-cyan-300" : "text-amber-300"}`}>{job.status}</td><td className="px-2 py-3 text-xs text-zinc-500">{ageLabel(job.completed_at || job.started_at || job.created_at)}</td></tr>)}</tbody></table></div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="mb-4 flex items-center gap-2 font-semibold text-white"><TriangleAlert className="h-4 w-4 text-rose-300" />Latest failure</div>
              {data.latest_failure ? <div className="rounded-xl border border-rose-400/20 bg-rose-500/[0.06] p-4 text-sm"><div className="font-medium text-rose-100">{data.latest_failure.canonical_name || data.latest_failure.building_code || "Unknown building"}</div><div className="mt-1 text-xs text-zinc-500">{data.latest_failure.provider} · {formatTime(data.latest_failure.updated_at)} · attempt {data.latest_failure.attempts}</div><p className="mt-3 break-words text-xs leading-5 text-rose-200">{data.latest_failure.last_error || "No error detail recorded"}</p></div> : <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4 text-sm text-emerald-200">No failed enrichment jobs are recorded.</div>}
              <div className="mt-6 mb-4 flex items-center gap-2 font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" />Latest outcomes</div>
              <div className="space-y-2">{data.recent_history.slice(0, 8).map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b border-white/5 pb-2 text-xs"><span className="truncate text-zinc-300">{item.canonical_name || item.building_code || "Unknown"}</span><span className="whitespace-nowrap text-zinc-500">{item.action} · {Math.round(Number(item.confidence || 0) * 100)}%</span></div>)}</div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default function LegacyBuildingEnrichmentPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/pipeline-health?tab=enrichment"); }, [router]);
  return null;
}
