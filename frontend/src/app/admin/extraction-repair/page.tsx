"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, Play, RefreshCw, Scissors, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { fetchJSON } from "@/lib/api";

type RepairJob = { id: number; parent_raw_id: number; status: string; pattern_id?: string; child_raw_ids?: number[]; existing_parsed_count?: number; error?: string | null; created_at: string };
type RepairState = { counts: Record<string, number>; recent_jobs: RepairJob[] };
type RepairRun = { dry_run: boolean; preview: Array<{ raw_id: number; pattern_id?: string | null; chunk_count: number; status: string }>; repaired: Array<{ raw_id: number; job_id: number; child_raw_ids: number[]; pattern_id: string }>; repaired_count: number };

const statusLabel: Record<string, string> = {
  queued: "Waiting to be repaired",
  running: "Being repaired",
  completed: "Repaired",
  no_split: "No separate listings found",
  failed: "Repair failed",
};

export default function ExtractionRepairPage() {
  const [state, setState] = useState<RepairState | null>(null);
  const [preview, setPreview] = useState<RepairRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setError(null); setState(await fetchJSON<RepairState>("/admin/extraction-repair")); }
    catch (err) { setError(err instanceof Error ? err.message : "Repair status could not be loaded"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(dryRun: boolean) {
    setBusy(true); setError(null);
    try {
      const result = await fetchJSON<RepairRun>("/admin/extraction-repair/run", { method: "POST", body: JSON.stringify({ limit: 25, dry_run: dryRun }) }, 120000);
      setPreview(result); await load();
    } catch (err) { setError(err instanceof Error ? err.message : "Repair batch failed"); }
    finally { setBusy(false); }
  }

  const counts = state?.counts || {};
  return <div className="mx-auto w-full max-w-7xl min-w-0 p-4 sm:p-6 lg:p-8">
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3 sm:gap-4"><Link href="/admin/pipeline-health?tab=providers" className="mt-1 text-zinc-400 hover:text-white"><ArrowLeft className="h-5 w-5" /></Link><div className="min-w-0"><h2 className="flex items-center gap-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-white sm:gap-3 sm:text-3xl sm:tracking-[-0.035em]"><Scissors className="h-5 w-5 shrink-0 text-cyan-300 sm:h-7 sm:w-7" /><span>Extraction boundary repair</span></h2><p className="mt-1 max-w-3xl text-sm text-zinc-500">Find historical parent broadcasts that skipped deterministic slicing, create immutable child evidence rows, and stop the stale parent from appearing in the market.</p></div></div>
      <button onClick={() => void load()} disabled={busy} className="flex items-center gap-2 rounded-lg border border-emerald-400/30 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-50"><RefreshCw className="h-4 w-4" />Refresh</button>
    </div>
    {error && <div className="mb-5 rounded-xl border border-rose-400/30 bg-rose-500/[0.08] p-4 text-sm text-rose-200">{error}</div>}
    <section className="mb-6 grid gap-3 sm:grid-cols-5">
      {["queued", "running", "completed", "no_split", "failed"].map((key) => <div key={key} className="rounded-2xl border border-white/10 bg-zinc-900/50 p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{key.replace("_", " ")}</div><div className="mt-1 text-2xl font-bold text-white">{(counts[key] || 0).toLocaleString("en-IN")}</div></div>)}
    </section>
    <section className="mb-6 rounded-2xl border border-cyan-400/20 bg-zinc-900/80 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold text-white">Repair historical broadcasts</h3>
          <p className="mt-1 text-sm text-zinc-400">Dry-run only inspects boundaries. Repair queues child slices; it does not call DeepSeek from this admin request.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void run(true)} disabled={busy} className="rounded-lg border border-white/15 px-3 py-2 text-sm text-zinc-200 hover:bg-white/5 disabled:opacity-50">Preview batch</button>
          <button onClick={() => void run(false)} disabled={busy} className="flex items-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-black hover:bg-emerald-300 disabled:opacity-50"><Play className="h-4 w-4" />{busy ? "Repairing…" : "Repair 25"}</button>
        </div>
      </div>
    </section>
    {preview && <section className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50"><div className="border-b border-white/10 p-5"><div className="flex items-center gap-2 font-semibold text-white"><CheckCircle2 className="h-4 w-4 text-emerald-300" />{preview.dry_run ? "Boundary preview" : `${preview.repaired_count} broadcasts repaired`}</div><p className="mt-1 text-xs text-zinc-500">{preview.dry_run ? "Only rows marked repairable will be changed when you run the repair." : "The extraction worker will process the new source slices on its next poll."}</p></div><div className="divide-y divide-white/5">{preview.preview.map((item) => <div key={item.raw_id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"><span className="text-zinc-200">Source message</span><span className="text-zinc-500">{item.chunk_count} listing slice{item.chunk_count === 1 ? "" : "s"}</span><span className={item.status === "repairable" ? "text-emerald-300" : "text-zinc-500"}>{item.status === "repairable" ? "Ready to repair" : "No separate listings found"}</span></div>)}</div></section>}
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50"><div className="flex items-center gap-2 border-b border-white/10 p-5 font-semibold text-white"><ShieldAlert className="h-4 w-4 text-amber-300" />Recent broadcast repairs</div>{!state?.recent_jobs?.length ? <div className="p-8 text-center text-sm text-zinc-500">No historical repair jobs have been queued.</div> : <div className="divide-y divide-white/5">{state.recent_jobs.map((job) => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"><div><span className="text-white">Source message</span><span className="ml-3 text-zinc-500">{(job.child_raw_ids || []).length} listing slices</span><details className="mt-1 text-xs text-zinc-600"><summary className="cursor-pointer hover:text-zinc-400">Technical details</summary><span>Repair #{job.id} · source #{job.parent_raw_id} · {job.pattern_id || "format not detected"}</span></details></div><span className="text-cyan-200">{statusLabel[job.status] || job.status}</span></div>)}</div>}</section>
  </div>;
}
