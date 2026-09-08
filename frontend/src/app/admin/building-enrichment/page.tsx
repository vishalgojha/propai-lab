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
  queue: { needs_review: number; pending: number; running: number; completed: number; failed: number; total: number };
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
    building_db_id: number;
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
    address: string | null;
    pincode: string | null;
    google_place_id: string | null;
    geocode_source: string | null;
    enrichment_confidence: number | null;
    latest_action: string | null;
    evidence_status: "recorded" | "needs_review" | "not_recorded";
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

type JobBrowser = { page: number; page_size: number; total: number; jobs: WorkerEvidence["recent_jobs"] };

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
  if (status === "failed") return "Review required";
  if (status === "running") return "In progress";
  if (status === "retry_scheduled") return "Retry queued";
  if (status === "needs_review") return "Needs review";
  return status ? status.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Waiting";
}

function evidenceLabel(job: WorkerEvidence["recent_jobs"][number]): string {
  if (job.evidence_status === "recorded") return job.address || job.micro_market || "Evidence recorded";
  if (job.evidence_status === "needs_review") return "Needs review — no verified address";
  return "No verified address recorded";
}

function nextActionLabel(job: WorkerEvidence["recent_jobs"][number]): string {
  if (job.status === "failed") {
    if (/competing locality|locality context|identity review/i.test(String(job.last_error || ""))) return "Review source locality";
    if (/not found|no confident|no results|could not verify/i.test(String(job.last_error || ""))) return "Check spelling and locality";
    return "Review error and retry";
  }
  if (job.status === "needs_review") return "Review building identity";
  if (job.status === "retry_scheduled") return "Retry queued";
  if (job.status === "running") return "Wait for provider result";
  if (job.status === "completed") return "No action needed";
  return "Monitor job";
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

function friendlyFailure(value: string | null | undefined, buildingName?: string | null): string {
  const message = String(value || "").trim();
  const name = buildingName || "this building";
  if (!message) return `Google Places did not produce a verified address for ${name}.`;
  if (/ambiguous same-name places results/i.test(message)) {
    return "We found more than one building with this name. Add the locality, broker name, or a price from the original message, then try again.";
  }
  if (/competing locality context|locality context|identity review/i.test(message)) {
    return "The source listings mention competing localities, so Google Places cannot be trusted to choose the right building automatically. Review the original WhatsApp listing’s locality, then retry enrichment.";
  }
  if (/not found|no confident|no results|could not verify/i.test(message)) {
    return `Google Places did not return a confident match for ${name}. Check the spelling and locality in the original WhatsApp listing, then retry enrichment.`;
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
  const [reviewJob, setReviewJob] = useState<WorkerEvidence["recent_jobs"][number] | null>(null);
  const [reviewName, setReviewName] = useState("");
  const [reviewLocality, setReviewLocality] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobBrowser>({ page: 1, page_size: 25, total: 0, jobs: [] });
  const [jobPage, setJobPage] = useState(1);
  const [jobStatus, setJobStatus] = useState("all");
  const [jobProvider, setJobProvider] = useState("all");
  const [jobQuery, setJobQuery] = useState("");
  const [jobQueryInput, setJobQueryInput] = useState("");
  const queueSlices = useMemo(() => [
    { key: "needs_review", label: "Needs review", value: data?.queue.needs_review ?? 0, color: "#F3B63F" },
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

  const loadJobs = useCallback(async () => {
    const params = new URLSearchParams({ page: String(jobPage), page_size: "25" });
    if (jobStatus !== "all") params.set("status", jobStatus);
    if (jobProvider !== "all") params.set("provider", jobProvider);
    if (jobQuery) params.set("q", jobQuery);
    const result = await fetchJSON<JobBrowser>(`/admin/building-enrichment/jobs?${params.toString()}`, undefined, 30000);
    setJobs(result);
  }, [jobPage, jobProvider, jobQuery, jobStatus]);

  const openReview = (job: WorkerEvidence["recent_jobs"][number]) => {
    setReviewJob(job);
    setReviewName(job.canonical_name || "");
    setReviewLocality(job.micro_market || "");
    setReviewMessage(null);
  };

  const submitReview = async (action: "enrich" | "reject") => {
    if (!reviewJob) return;
    setReviewBusy(true);
    setReviewMessage(null);
    try {
      await fetchJSON(`/admin/building-enrichment/jobs/${reviewJob.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, canonical_name: reviewName, micro_market: reviewLocality }),
      });
      setReviewJob(null);
      await load();
    } catch (err) {
      setReviewMessage(err instanceof Error ? err.message : "Review could not be saved");
    } finally {
      setReviewBusy(false);
    }
  };

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

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

          <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            <Metric label="Needs review" value={data.queue.needs_review} note="Human approval before Google" tone="text-amber-300" />
            <Metric label="Pending" value={data.queue.pending} note="Approved for worker" tone="text-amber-300" />
            <Metric label="Running" value={data.queue.running} note="Currently claimed" tone="text-cyan-300" />
            <Metric label="Completed" value={data.queue.completed} note="Successful jobs" tone="text-emerald-300" />
            <Metric label="Failed" value={data.queue.failed} note="Terminal failures" tone={data.queue.failed ? "text-rose-300" : "text-white"} />
            <Metric label="Total" value={data.queue.total} note="All enrichment jobs" />
          </section>

          <section className="mb-4 grid min-w-0 gap-4 lg:grid-cols-1">
            <Card className="p-4">
              <div className="mb-4 flex items-start justify-between gap-4"><div className="flex items-center gap-2 font-semibold text-white"><Clock3 className="h-4 w-4 text-cyan-300" />Recent job activity</div><p className="max-w-xs text-right text-[11px] text-zinc-500">Job status shows provider execution. Evidence shows whether verified building data was actually recorded.</p></div>
              <div className="mb-4 flex flex-wrap items-center gap-2"><input value={jobQueryInput} onChange={(event) => setJobQueryInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { setJobPage(1); setJobQuery(jobQueryInput.trim()); } }} placeholder="Search building or locality" className="min-w-[220px] flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-500 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/20" /><select value={jobStatus} onChange={(event) => { setJobPage(1); setJobStatus(event.target.value); }} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"><option value="all">All statuses</option><option value="needs_review">Needs review</option><option value="failed">Review required</option><option value="running">In progress</option><option value="completed">Completed</option><option value="pending">Pending</option></select><select value={jobProvider} onChange={(event) => { setJobPage(1); setJobProvider(event.target.value); }} className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"><option value="all">All providers</option><option value="google_places">Google Places</option><option value="crawl4ai">Crawl4AI</option><option value="unassigned">Unassigned</option></select><button onClick={() => { setJobPage(1); setJobQuery(jobQueryInput.trim()); }} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700">Search</button></div>
              <div className="overflow-x-auto"><table className="w-full min-w-0 table-fixed text-sm"><thead className="text-left text-[11px] uppercase tracking-wider text-zinc-500"><tr className="border-b border-white/10"><th className="w-[24%] px-2 py-3">Building</th><th className="w-[10%] px-2 py-3">Source</th><th className="w-[12%] px-2 py-3">Job</th><th className="w-[22%] px-2 py-3">Evidence</th><th className="w-[15%] px-2 py-3">Next action</th><th className="w-[8%] px-2 py-3">Updated</th><th className="w-[9%] px-2 py-3">Review</th></tr></thead><tbody>{jobs.jobs.map((job) => <tr key={job.id} className="border-b border-white/5"><td className="break-words px-2 py-3 text-zinc-800">{job.building_code ? <Link href={`/buildings/${encodeURIComponent(job.building_code)}`} className="font-medium text-emerald-800 hover:underline">{job.canonical_name || job.building_code}</Link> : (job.canonical_name || "Unknown building")}<div className="text-xs text-zinc-600">{job.micro_market || "Locality not recorded"}</div>{job.building_code && <Link href={`/buildings/${encodeURIComponent(job.building_code)}`} className="mt-1 inline-block text-[11px] text-zinc-500 hover:text-[var(--foreground)]">Open address and listings →</Link>}</td><td className="break-words px-2 py-3 text-xs text-zinc-700">{providerLabel(job.provider)}</td><td className={`break-words px-2 py-3 text-xs font-semibold uppercase ${job.status === "completed" ? "text-emerald-800" : job.status === "failed" ? "text-rose-700" : job.status === "running" ? "text-cyan-800" : "text-amber-800"}`}>{jobStatusLabel(job.status)}</td><td className={`break-words px-2 py-3 text-xs font-semibold ${job.evidence_status === "recorded" ? "text-emerald-800" : job.evidence_status === "needs_review" ? "text-amber-800" : "text-rose-700"}`}>{evidenceLabel(job)}</td><td className={`break-words px-2 py-3 text-xs ${job.status === "failed" || job.status === "needs_review" ? "font-semibold text-amber-800" : "text-zinc-700"}`}>{nextActionLabel(job)}</td><td className="px-2 py-3 text-xs text-zinc-600">{ageLabel(job.completed_at || job.started_at || job.created_at)}</td><td className="px-2 py-3">{(job.status === "needs_review" || job.status === "failed") && <button onClick={() => openReview(job)} className="rounded-md border border-amber-700/40 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-700/40">Review &amp; enrich</button>}</td></tr>)}</tbody></table></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 pt-3 text-sm text-zinc-600"><span>{jobs.total ? `${((jobs.page - 1) * jobs.page_size) + 1}–${Math.min(jobs.page * jobs.page_size, jobs.total)} of ${jobs.total}` : "No matching jobs"}</span><div className="flex items-center gap-2"><button disabled={jobs.page <= 1} onClick={() => setJobPage((page) => Math.max(1, page - 1))} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">Previous</button><button disabled={jobs.page * jobs.page_size >= jobs.total} onClick={() => setJobPage((page) => page + 1)} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40">Next</button></div></div>
            </Card>

            <Card className="p-4">
              <div className="mb-4 flex items-center justify-between gap-3"><div><div className="font-semibold text-white">Queue mix</div><p className="mt-1 text-xs text-zinc-500">Live share of enrichment jobs by state</p></div><span className="text-xs text-zinc-500">{data.queue.total.toLocaleString("en-IN")} jobs</span></div>
              {queueSlices.length ? <div className="mb-6 grid items-center gap-3 border-b border-white/10 pb-6 sm:grid-cols-[minmax(0,1fr)_150px]"><ChartContainer config={Object.fromEntries(queueSlices.map((slice) => [slice.key, { label: slice.label, color: slice.color }]))} className="h-[170px] min-h-0"><PieChart><Tooltip /><Pie data={queueSlices} dataKey="value" nameKey="label" innerRadius={48} outerRadius={72} paddingAngle={3} stroke="transparent">{queueSlices.map((slice) => <Cell key={slice.key} fill={slice.color} />)}</Pie></PieChart></ChartContainer><div className="space-y-2">{queueSlices.map((slice) => <div key={slice.key} className="flex items-center justify-between gap-3 text-xs"><span className="flex items-center gap-2 text-zinc-300"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: slice.color }} />{slice.label}</span><span className="font-semibold text-white">{slice.value.toLocaleString("en-IN")}</span></div>)}</div></div> : <div className="mb-6 border-b border-white/10 pb-6 text-sm text-zinc-500">No enrichment jobs are currently recorded.</div>}
              <div className="mb-4 flex items-center gap-2 font-semibold text-white"><TriangleAlert className="h-4 w-4 text-rose-300" />Latest review required</div>
              {data.latest_failure ? <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm"><div className="font-semibold text-rose-900">{data.latest_failure.canonical_name || data.latest_failure.building_code || "Unknown building"}</div><div className="mt-1 text-xs text-rose-800">{providerLabel(data.latest_failure.provider)} · {formatTime(data.latest_failure.updated_at)} · attempt {data.latest_failure.attempts}</div><p className="mt-3 break-words text-xs leading-5 text-rose-900">{friendlyFailure(data.latest_failure.last_error, data.latest_failure.canonical_name || data.latest_failure.building_code)}</p><div className="mt-3 border-t border-rose-900/15 pt-3 text-xs font-semibold text-rose-900">Who acts: enrichment operator</div><div className="mt-1 text-xs leading-5 text-rose-900">Next step: review the original WhatsApp locality and retry the enrichment job. No verified address was written for this job.</div></div> : <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">{data.queue.needs_review ? `${data.queue.needs_review.toLocaleString("en-IN")} candidate${data.queue.needs_review === 1 ? "" : "s"} await identity review in the table above.` : "No building candidates currently need review."}</div>}
              <div className="mt-6 mb-4 flex items-center gap-2 font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" />Latest outcomes</div>
              <div className="space-y-2">{data.recent_history.slice(0, 8).map((item) => <div key={item.id} className="flex items-center justify-between gap-3 border-b border-white/5 pb-2 text-xs"><span className="truncate text-zinc-300">{item.canonical_name || item.building_code || "Unknown building"}</span><span className="whitespace-nowrap text-zinc-500">{outcomeLabel(item.action)} · {confidenceLabel(item.confidence)}</span></div>)}</div>
            </Card>
          </section>
        </>
      )}
      {reviewJob && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="review-building-title"><div className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-950 p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">Identity review</p><h2 id="review-building-title" className="mt-1 text-xl font-semibold text-white">Confirm before Google enrichment</h2><p className="mt-1 text-sm text-zinc-400">This candidate was held back because source names can be landmarks, projects, or broker notes.</p></div><button onClick={() => setReviewJob(null)} className="text-zinc-500 hover:text-white" aria-label="Close review">×</button></div><div className="mt-5 space-y-4"><label className="block text-sm text-zinc-300">Building name<input value={reviewName} onChange={(event) => setReviewName(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-white outline-none focus:border-amber-300/60" /></label><label className="block text-sm text-zinc-300">Locality / micro-market<input value={reviewLocality} onChange={(event) => setReviewLocality(event.target.value)} placeholder="e.g. Bandra West" className="mt-1 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-white outline-none focus:border-amber-300/60" /></label>{reviewJob.last_error && <p className="rounded-lg border border-rose-400/20 bg-rose-500/[0.08] p-3 text-xs leading-5 text-rose-200">{friendlyFailure(reviewJob.last_error, reviewJob.canonical_name)}</p>}{reviewMessage && <p className="text-sm text-rose-300">{reviewMessage}</p>}</div><div className="mt-6 flex flex-wrap justify-end gap-2"><button disabled={reviewBusy} onClick={() => void submitReview("reject")} className="rounded-lg border border-rose-400/30 px-3 py-2 text-sm text-rose-200 hover:bg-rose-400/10 disabled:opacity-50">Not a building</button><button disabled={reviewBusy || !reviewName.trim()} onClick={() => void submitReview("enrich")} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50">{reviewBusy ? "Saving…" : "Save & enrich"}</button></div></div></div>}
    </div>
  );
}

export default function LegacyBuildingEnrichmentPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/pipeline-health?tab=enrichment"); }, [router]);
  return null;
}
