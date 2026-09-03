"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock3, MapPin, RefreshCw, Server, TriangleAlert, XCircle } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import { ChartContainer } from "@/components/ui/chart";
import { Card } from "@/components/ui/card";

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

function providerLabel(value: string | null | undefined): string {
  const provider = String(value || "").trim().toLowerCase();
  if (provider === "google_places") return "Google Places";
  return provider ? provider.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Building information service";
}

function jobStatusLabel(value: string | null | undefined): string {
  const status = String(value || "").trim().toLowerCase();
  if (status === "completed") return "Completed";
  if (status === "failed") return "Needs attention";
  if (status === "running") return "In progress";
  if (status === "retry_scheduled") return "Retry queued";
  if (status === "needs_review") return "Needs review";
  return status ? status.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Waiting";
}

function outcomeLabel(value: string | null | undefined): string {
  const action = String(value || "").trim().toLowerCase();
  if (action === "enriched") return "Details confirmed";
  if (action === "failed") return "Could not confirm";
  if (action === "needs_review") return "Needs your review";
  if (action === "retry_scheduled") return "Retry queued";
  return action ? action.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Recorded";
}

function confidenceLabel(value: number | null | undefined): string {
  const confidence = Number(value || 0);
  if (confidence >= 0.85) return "Strong match";
  if (confidence >= 0.6) return "Possible match";
  return "Could not confirm";
}

function friendlyFailure(value: string | null | undefined): string {
  const message = String(value || "").trim();
  if (!message) return "We could not confirm this building yet.";
  if (/ambiguous same-name places results/i.test(message)) {
    return "We found more than one building with this name. Add the locality, broker name, or a price from the original message, then try again.";
  }
  return message;
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

export function BuildingEnrichmentPage() {
  const [data, setData] = useState<WorkerEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queueSlices = useMemo(() => [
    { key: "completed", label: "Completed", value: data?.queue.completed ?? 0, color: "#9BE564" },
    { key: "failed", label: "Failed", value: data?.queue.failed ?? 0, color: "#FF6B5F" },
    { key: "running", label: "Running", value: data?.queue.running ?? 0, color: "#49B7BD" },
    { key: "pending", label: "Pending", value: data?.queue.pending ?? 0, color: "#F3B63F" },
  ].filter((slice) => slice.value > 0), [data]);

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
    <div className="mx-auto w-full max-w-7xl min-w-0 p-4 sm:p-5 lg:px-7 lg:py-4">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/admin/pipeline-health?tab=enrichment" aria-label="Back to pipeline health" className="mt-1 text-zinc-400 hover:text-white"><ArrowLeft className="h-5 w-5" /></Link>
          <div className="min-w-0">
            <p className="propai-kicker text-[9px] font-semibold sm:text-[10px]">Platform operations</p>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-white sm:gap-3 sm:text-3xl sm:tracking-[-0.035em]"><MapPin className="h-5 w-5 shrink-0 text-amber-400 sm:h-7 sm:w-7" /><span>Building Enrichment Worker</span></h1>
            <p className="mt-1 text-sm text-zinc-500">Check which building details are confirmed and which need a closer look</p>
          </div>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-2 rounded-lg border border-cyan-400/30 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-400/10"><RefreshCw className="h-4 w-4" />Refresh</button>
      </div>

      {loading && <div className="rounded-xl border border-white/10 p-5 text-sm text-zinc-500">Loading worker evidence…</div>}
      {error && <div className="rounded-xl border border-red-400/30 bg-red-500/[0.08] p-4 text-sm text-red-200">{error}</div>}

      {data && state && (
        <>
          <Card className="mb-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`flex h-11 w-11 items-center justify-center rounded-xl border ${state.tone}`}><StateIcon className="h-5 w-5" /></div>
                <div>
                  <div className="text-lg font-semibold text-white">{state.label}</div>
                <div className="text-xs text-zinc-500">Building details service · {providerLabel(data.recent_jobs[0]?.provider)}</div>
                </div>
              </div>
              <div className="text-right text-xs text-zinc-500">
                <div>Last heartbeat: <span className="text-zinc-300">{ageLabel(data.worker.heartbeat_at)}</span></div>
                <div>{formatTime(data.worker.heartbeat_at)}</div>
              </div>
            </div>
            <div className="mt-5 grid gap-3 border-t border-white/10 pt-4 text-xs text-zinc-500 sm:grid-cols-3">
              <div>Service version: <span className="font-mono text-zinc-300">{data.worker.runtime_version || "Not reported"}</span></div>
              <div>Last confirmed building: <span className="text-zinc-300">{formatTime(data.latest_success_at)}</span></div>
              <div>Processing setup: <span className="text-zinc-300">{data.worker.config ? `${String(data.worker.config.batch_size ?? "—")} at a time · ${String(data.worker.config.concurrency ?? "—")} parallel` : "Not reported"}</span></div>
            </div>
          </Card>

          <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Metric label="Pending" value={data.queue.pending} note="Waiting for worker" tone="text-amber-300" />
            <Metric label="Running" value={data.queue.running} note="Currently claimed" tone="text-cyan-300" />
            <Metric label="Completed" value={data.queue.completed} note="Successful jobs" tone="text-emerald-300" />
            <Metric label="Failed" value={data.queue.failed} note="Terminal failures" tone={data.queue.failed ? "text-rose-300" : "text-white"} />
            <Metric label="Total" value={data.queue.total} note="All enrichment jobs" />
          </section>

          <section className="mb-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card className="p-4">
              <div className="mb-4 flex items-center gap-2 font-semibold text-white"><Clock3 className="h-4 w-4 text-cyan-300" />Recent job activity</div>
              <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500"><tr className="border-b border-white/10"><th className="px-2 py-3">Building</th><th className="px-2 py-3">Source</th><th className="px-2 py-3">Status</th><th className="px-2 py-3">Updated</th></tr></thead><tbody>{data.recent_jobs.slice(0, 15).map((job) => <tr key={job.id} className="border-b border-white/5"><td className="px-2 py-3 text-zinc-200">{job.canonical_name || job.building_code || "Unknown building"}<div className="text-xs text-zinc-600">{job.micro_market || "Locality not recorded"}</div></td><td className="px-2 py-3 text-xs text-zinc-400">{providerLabel(job.provider)}</td><td className={`px-2 py-3 text-xs font-semibold uppercase ${job.status === "completed" ? "text-emerald-300" : job.status === "failed" ? "text-rose-300" : job.status === "running" ? "text-cyan-300" : "text-amber-300"}`}>{jobStatusLabel(job.status)}</td><td className="px-2 py-3 text-xs text-zinc-500">{ageLabel(job.completed_at || job.started_at || job.created_at)}</td></tr>)}</tbody></table></div>
            </Card>

            <Card className="p-4">
              <div className="mb-4 flex items-center justify-between gap-3"><div><div className="font-semibold text-white">Queue mix</div><p className="mt-1 text-xs text-zinc-500">Live share of enrichment jobs by state</p></div><span className="text-xs text-zinc-500">{data.queue.total.toLocaleString("en-IN")} jobs</span></div>
              {queueSlices.length ? <div className="mb-6 grid items-center gap-3 border-b border-white/10 pb-6 sm:grid-cols-[minmax(0,1fr)_150px]"><ChartContainer config={Object.fromEntries(queueSlices.map((slice) => [slice.key, { label: slice.label, color: slice.color }]))} className="h-[170px] min-h-0"><PieChart><Tooltip /><Pie data={queueSlices} dataKey="value" nameKey="label" innerRadius={48} outerRadius={72} paddingAngle={3} stroke="transparent">{queueSlices.map((slice) => <Cell key={slice.key} fill={slice.color} />)}</Pie></PieChart></ChartContainer><div className="space-y-2">{queueSlices.map((slice) => <div key={slice.key} className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-2 text-zinc-300"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: slice.color }} />{slice.label}</span><span className="font-semibold text-white">{slice.value.toLocaleString("en-IN")}</span></div>)}</div></div> : <div className="mb-6 border-b border-white/10 pb-6 text-sm text-zinc-500">No enrichment jobs are currently recorded.</div>}
              <div className="mb-4 flex items-center gap-2 font-semibold text-white"><TriangleAlert className="h-4 w-4 text-rose-300" />Latest failure</div>
              {data.latest_failure ? <div className="rounded-xl border border-rose-400/20 bg-rose-500/[0.06] p-4 text-sm"><div className="font-medium text-rose-100">{data.latest_failure.canonical_name || data.latest_failure.building_code || "Unknown building"}</div><div className="mt-1 text-xs text-rose-200/75">{providerLabel(data.latest_failure.provider)} · {formatTime(data.latest_failure.updated_at)} · attempt {data.latest_failure.attempts}</div><p className="mt-3 break-words text-xs leading-5 text-rose-200">{friendlyFailure(data.latest_failure.last_error)}</p></div> : <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4 text-sm text-emerald-200">No building records currently need attention.</div>}
              <div className="mt-6 mb-4 flex items-center gap-2 font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" />Latest outcomes</div>
              <div className="space-y-2">{data.recent_history.slice(0, 8).map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b border-white/5 pb-2 text-xs"><span className="truncate text-zinc-300">{item.canonical_name || item.building_code || "Unknown building"}</span><span className="whitespace-nowrap text-zinc-500">{outcomeLabel(item.action)} · {confidenceLabel(item.confidence)}</span></div>)}</div>
            </Card>
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
