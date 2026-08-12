"use client";

export const dynamic = "force-dynamic";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Database,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface EntityStatus {
  entity_type: string;
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  embedded: number;
}

interface SemanticQuality {
  expected_entities: number;
  indexed_entities: number;
  coverage_pct: number;
  stale_entities: number;
  orphan_vectors: number;
  unresolved_jobs: number | null;
  invalid_documents: number;
  duplicate_model_rows: number;
  alias_checks: {
    building_aliases: { tested: number; hit_at_5: number; hit_rate_at_5: number };
    broker_aliases: { tested: number; hit_at_5: number; hit_rate_at_5: number };
  };
}

interface SemanticStatus {
  jobs: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    exhausted: number;
  };
  vectors: { total: number; model_count: number };
  model: string;
  dimensions: number;
  last_completed_at: string | null;
  last_stored_at: string | null;
  generated_at: string;
  latest_failure: {
    entity_type: string;
    source_table: string;
    attempts: number;
    last_error: string;
    updated_at: string;
  } | null;
  by_entity: EntityStatus[];
  quality?: SemanticQuality;
}

interface ProbeResult {
  entity_type: string;
  source_table: string;
  source_id: number;
  tenant_id: string | null;
  similarity: number;
  content: string;
  metadata: Record<string, unknown>;
}

interface EvalCase {
  id: number;
  tenant_id: string | null;
  query: string;
  entity_type: string;
  source_table: string;
  source_id: number;
  top_k: number;
  active: boolean;
  last_status: "never_run" | "passed" | "failed" | "error";
  last_rank: number | null;
  last_similarity: number | null;
  last_model: string | null;
  last_error: string | null;
  last_run_at: string | null;
}

interface EvalEntitySummary {
  total: number;
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  threshold_metric: "recall_at_5" | "recall_at_10";
  threshold: number;
  gate_passed: boolean;
}

interface EvalSummary {
  run_id?: number;
  created_at?: string;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  model: string;
  ran_at: string;
  gate_passed: boolean | null;
  recall_at_5: number;
  recall_at_10: number;
  mrr: number;
  by_entity: Record<string, EvalEntitySummary>;
}

const labels: Record<string, string> = {
  listing: "Listings",
  requirement: "Requirements",
  building: "Buildings",
  building_alias: "Building aliases",
  locality: "Localities",
  broker: "Brokers",
  broker_alias: "Broker aliases",
};

function dateTime(value: string | null): string {
  if (!value) return "No vector stored yet";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function StatCard({ label, value, note, tone = "text-white" }: {
  label: string;
  value: number;
  note: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone}`}>{value.toLocaleString()}</div>
      <div className="mt-1 text-xs text-zinc-500">{note}</div>
    </div>
  );
}

export default function SemanticEmbeddingsPage() {
  const [data, setData] = useState<SemanticStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probeQuery, setProbeQuery] = useState("");
  const [probeResults, setProbeResults] = useState<ProbeResult[] | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [evalCases, setEvalCases] = useState<EvalCase[]>([]);
  const [evalLoading, setEvalLoading] = useState(true);
  const [evalRunning, setEvalRunning] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const evalAutoStarted = useRef(false);

  const quality = useMemo<SemanticQuality>(() => data?.quality ?? {
    expected_entities: data?.jobs.total ?? 0,
    indexed_entities: Math.min(data?.vectors.total ?? 0, data?.jobs.total ?? 0),
    coverage_pct: data?.jobs.total ? Math.min(100, ((data.vectors.total / data.jobs.total) * 100)) : 0,
    stale_entities: 0,
    orphan_vectors: 0,
    unresolved_jobs: null,
    invalid_documents: 0,
    duplicate_model_rows: 0,
    alias_checks: {
      building_aliases: { tested: 0, hit_at_5: 0, hit_rate_at_5: 0 },
      broker_aliases: { tested: 0, hit_at_5: 0, hit_rate_at_5: 0 },
    },
  }, [data]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await fetchJSON<SemanticStatus>("/admin/semantic-embeddings", undefined, 30000);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Semantic embedding evidence could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvalCases = useCallback(async () => {
    setEvalLoading(true);
    try {
      const result = await fetchJSON<EvalCase[]>("/admin/semantic-embeddings/evals", undefined, 30000);
      setEvalCases(result);
      setEvalError(null);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Retrieval evaluation cases could not be loaded");
    } finally {
      setEvalLoading(false);
    }
  }, []);

  const loadEvalSummary = useCallback(async () => {
    try {
      const result = await fetchJSON<EvalSummary | null>("/admin/semantic-embeddings/evals/summary", undefined, 30000);
      setEvalSummary(result);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Retrieval evaluation summary could not be loaded");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void load();
      void loadEvalCases();
      void loadEvalSummary();
    }, 0);
    const timer = window.setInterval(() => {
      void load(true);
      void loadEvalCases();
      void loadEvalSummary();
    }, 60000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load, loadEvalCases, loadEvalSummary]);

  const coverage = useMemo(() => {
    return Math.min(100, quality.coverage_pct);
  }, [quality]);

  const runProbe = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (probeQuery.trim().length < 2) return;
    setProbeLoading(true);
    setProbeError(null);
    try {
      const result = await fetchJSON<{ query: string; results: ProbeResult[] }>("/admin/semantic-embeddings/probe", {
        method: "POST",
        body: JSON.stringify({ query: probeQuery.trim() }),
      }, 30000);
      setProbeResults(result.results);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Retrieval probe failed");
      setProbeResults(null);
    } finally {
      setProbeLoading(false);
    }
  };

  const saveEvalCase = async (row: ProbeResult) => {
    try {
      await fetchJSON<EvalCase>("/admin/semantic-embeddings/evals", {
        method: "POST",
        body: JSON.stringify({
          query: probeQuery.trim(),
          entity_type: row.entity_type,
          source_table: row.source_table,
          source_id: row.source_id,
          tenant_id: row.tenant_id,
          top_k: 5,
        }),
      });
      await loadEvalCases();
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Retrieval case could not be saved");
    }
  };

  const runEvals = useCallback(async () => {
    setEvalRunning(true);
    setEvalError(null);
    try {
      const result = await fetchJSON<EvalSummary>("/admin/semantic-embeddings/evals/run", { method: "POST" }, 120000);
      setEvalSummary(result);
      await loadEvalCases();
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Retrieval evaluation failed");
    } finally {
      setEvalRunning(false);
    }
  }, [loadEvalCases]);

  useEffect(() => {
    if (
      evalAutoStarted.current ||
      evalSummary ||
      evalRunning ||
      !evalCases.length ||
      !data ||
      data.jobs.failed > 0 ||
      quality.coverage_pct < 99
    ) return;
    evalAutoStarted.current = true;
    void runEvals();
  }, [data, evalCases.length, evalRunning, evalSummary, quality.coverage_pct, runEvals]);

  const deleteEvalCase = async (caseId: number) => {
    try {
      await fetchJSON(`/admin/semantic-embeddings/evals/${caseId}`, { method: "DELETE" });
      setEvalCases((cases) => cases.filter((item) => item.id !== caseId));
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : "Retrieval case could not be removed");
    }
  };

  const evalPassed = evalCases.filter((item) => item.last_status === "passed").length;
  const evalRunCount = evalCases.filter((item) => item.last_status !== "never_run").length;

  return (
    <div className="mx-auto max-w-6xl p-3 sm:p-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/admin" className="mt-1 text-zinc-400 hover:text-white" aria-label="Back to admin">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-bold text-white sm:text-2xl">
              <BrainCircuit className="h-6 w-6 text-cyan-400" />
              Semantic Embeddings
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              Live evidence for the asynchronous vector index. Embeddings retrieve candidates; deterministic evidence still decides identity.
            </p>
          </div>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 text-sm text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </header>

      {error && (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          {error}. The last real snapshot remains visible below when available.
        </div>
      )}

      {!data && loading ? (
        <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 py-16 text-zinc-400">
          <LoaderCircle className="h-5 w-5 animate-spin" /> Reading the semantic queue…
        </div>
      ) : data ? (
        <>
          <div className="mb-4 grid gap-3 min-[430px]:grid-cols-2 lg:grid-cols-5">
            <StatCard label="Indexed entities" value={quality.indexed_entities} note="Unique rows in the current model" tone="text-emerald-300" />
            <StatCard label="Pending" value={data.jobs.pending} note="Waiting for the worker" tone="text-amber-300" />
            <StatCard label="Running" value={data.jobs.running} note="Currently claimed jobs" tone="text-cyan-300" />
            <StatCard label="Completed jobs" value={data.jobs.completed} note="Queue work completed" />
            <StatCard label="Failed" value={data.jobs.failed} note={`${data.jobs.exhausted.toLocaleString()} exhausted retries`} tone={data.jobs.failed ? "text-red-300" : "text-white"} />
          </div>

          <section className="mb-6 rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Database className="h-4 w-4 text-cyan-400" /> Index coverage
                </div>
                <p className="mt-1 text-xs text-zinc-500">
                  {data.model} · {data.dimensions.toLocaleString()} dimensions · {data.vectors.model_count} model version{data.vectors.model_count === 1 ? "" : "s"}
                </p>
              </div>
              <div className="text-3xl font-bold text-white">{coverage.toFixed(1)}%</div>
            </div>
            <div className="mt-4 h-3 overflow-hidden rounded-full bg-zinc-800">
              <div className="h-full rounded-full bg-cyan-400 transition-all" style={{ width: `${coverage}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-zinc-500">
              <span>{quality.indexed_entities.toLocaleString()} current entities indexed from {quality.expected_entities.toLocaleString()} source entities</span>
              <span>Last stored: {dateTime(data.last_stored_at)}</span>
            </div>
          </section>

          <section className="mb-6 rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="flex items-center gap-2 font-semibold text-white">
                  <ShieldCheck className="h-4 w-4 text-emerald-400" /> Correctness evidence
                </h2>
                <p className="mt-1 text-xs text-zinc-500">These checks test whether vectors still correspond to searchable source rows—not merely whether the worker ran.</p>
              </div>
              <span className="text-xs text-zinc-500">Latest model only · {quality.indexed_entities.toLocaleString()} unique entities</span>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <QualityCheck label="Queue alignment" value={`${coverage.toFixed(1)}%`} note={`${quality.expected_entities.toLocaleString()} queued source entities`} good={quality.expected_entities === 0 || coverage >= 99} />
              <QualityCheck label="Stale vectors" value={quality.stale_entities} note="Source changed after vector write" good={quality.stale_entities === 0} />
              <QualityCheck label="Orphan vectors" value={quality.orphan_vectors} note="No matching source row" good={quality.orphan_vectors === 0} />
              <QualityCheck label="Invalid documents" value={quality.invalid_documents} note="Empty or malformed vector text" good={quality.invalid_documents === 0} />
            </div>
            <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
              <AliasCheck label="Building alias → canonical building" check={quality.alias_checks.building_aliases} />
              <AliasCheck label="Broker alias → canonical broker" check={quality.alias_checks.broker_aliases} />
            </div>
            {(quality.duplicate_model_rows > 0 || (quality.unresolved_jobs != null && quality.unresolved_jobs > 0)) && (
              <p className="mt-4 text-xs text-amber-300">
                {quality.duplicate_model_rows.toLocaleString()} old-model duplicate row{quality.duplicate_model_rows === 1 ? "" : "s"}{quality.unresolved_jobs != null ? ` and ${quality.unresolved_jobs.toLocaleString()} unresolved job${quality.unresolved_jobs === 1 ? "" : "s"}` : ""} remain outside the current index.
              </p>
            )}
          </section>

          <section className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50">
            <div className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold text-white">Golden retrieval set</h2>
                <p className="mt-1 text-xs text-zinc-500">Grounded golden cases from real source relationships and inventory. Runs automatically once coverage reaches 99%; a pass means the expected entity appears within its configured top-k.</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-zinc-500">{evalPassed}/{evalCases.length} passed · {evalRunCount} evaluated</span>
                <button onClick={() => void runEvals()} disabled={evalRunning || !evalCases.length} className="flex h-9 items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 text-sm text-emerald-200 hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-50">
                  {evalRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Run evaluation
                </button>
              </div>
            </div>
            {evalSummary && (
              <div className="border-b border-white/10 bg-zinc-950/30 px-5 py-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <EvalMetric label="Gate" value={evalSummary.gate_passed ? "PASS" : "FAIL"} good={evalSummary.gate_passed} note={`${evalSummary.passed}/${evalSummary.total} cases at configured top-k`} />
                  <EvalMetric label="Recall@5" value={`${(evalSummary.recall_at_5 * 100).toFixed(1)}%`} good={evalSummary.recall_at_5 >= 0.9} note="Expected result in top 5" />
                  <EvalMetric label="Recall@10" value={`${(evalSummary.recall_at_10 * 100).toFixed(1)}%`} good={evalSummary.recall_at_10 >= 0.8} note="Expected result in top 10" />
                  <EvalMetric label="MRR" value={evalSummary.mrr.toFixed(3)} good={evalSummary.mrr >= 0.7} note="Average reciprocal rank" />
                </div>
                <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
                  <table className="w-full min-w-[680px] text-xs">
                    <thead className="border-b border-white/10 text-left uppercase tracking-wider text-zinc-600">
                      <tr><th className="px-3 py-2">Entity type</th><th className="px-3 py-2 text-right">Cases</th><th className="px-3 py-2 text-right">Recall@5</th><th className="px-3 py-2 text-right">Recall@10</th><th className="px-3 py-2 text-right">MRR</th><th className="px-3 py-2 text-right">Gate</th></tr>
                    </thead>
                    <tbody>
                      {Object.entries(evalSummary.by_entity).map(([entityType, item]) => (
                        <tr key={entityType} className="border-b border-white/5 last:border-0">
                          <td className="px-3 py-2 text-zinc-300">{labels[entityType] ?? entityType}</td>
                          <td className="px-3 py-2 text-right text-zinc-500">{item.total}</td>
                          <td className="px-3 py-2 text-right text-zinc-400">{(item.recall_at_5 * 100).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right text-zinc-400">{(item.recall_at_10 * 100).toFixed(1)}%</td>
                          <td className="px-3 py-2 text-right text-zinc-400">{item.mrr.toFixed(3)}</td>
                          <td className={`px-3 py-2 text-right font-semibold ${item.gate_passed ? "text-emerald-300" : "text-red-300"}`}>{item.gate_passed ? "PASS" : "FAIL"} <span className="font-normal text-zinc-600">({(item.threshold * 100).toFixed(0)}% {item.threshold_metric.replace("recall_at_", "@")} )</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {evalError && <p className="border-b border-red-500/20 bg-red-500/5 px-5 py-3 text-sm text-red-300">{evalError}</p>}
            {evalLoading ? (
              <div className="px-5 py-8 text-sm text-zinc-500">Loading golden cases…</div>
            ) : evalCases.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-zinc-500">
                    <tr className="border-b border-white/10">
                      <th className="px-5 py-3 text-left">Query</th>
                      <th className="px-3 py-3 text-left">Expected entity</th>
                      <th className="px-3 py-3 text-right">Top-k</th>
                      <th className="px-3 py-3 text-right">Last rank</th>
                      <th className="px-3 py-3 text-left">Status</th>
                      <th className="px-5 py-3 text-right"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {evalCases.map((item) => (
                      <tr key={item.id} className="border-b border-white/5 last:border-0">
                        <td className="max-w-[300px] px-5 py-3 text-zinc-200">{item.query}</td>
                        <td className="px-3 py-3 text-xs text-zinc-400">{labels[item.entity_type] ?? item.entity_type}<br /><span className="text-zinc-600">{item.source_table}:{item.source_id}</span></td>
                        <td className="px-3 py-3 text-right text-zinc-400">{item.top_k}</td>
                        <td className="px-3 py-3 text-right text-zinc-400">{item.last_rank ?? "—"}</td>
                        <td className={`px-3 py-3 text-xs font-semibold uppercase ${item.last_status === "passed" ? "text-emerald-300" : item.last_status === "never_run" ? "text-zinc-500" : "text-red-300"}`}>{item.last_status.replace("_", " ")}</td>
                        <td className="px-5 py-3 text-right"><button onClick={() => void deleteEvalCase(item.id)} className="text-xs text-zinc-600 hover:text-red-300">Remove</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
                  <div className="px-5 py-8 text-sm text-zinc-400">No golden cases yet. Run a probe, verify the expected result, then save it as a case.</div>
            )}
          </section>

          <section className="mb-6 rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
            <div className="flex items-center gap-2 font-semibold text-white">
              <Search className="h-4 w-4 text-cyan-400" /> Retrieval probe
            </div>
            <p className="mt-1 text-xs text-zinc-500">Run the same embedding + pgvector path used by search and inspect the ranked candidates.</p>
            <form onSubmit={runProbe} className="mt-4 flex flex-col gap-2 sm:flex-row">
              <input
                value={probeQuery}
                onChange={(event) => setProbeQuery(event.target.value)}
                placeholder="Try: 3 BHK rent in Bandra West"
                className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-zinc-950 px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-cyan-400/50"
              />
              <button type="submit" disabled={probeLoading || probeQuery.trim().length < 2} className="flex h-10 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 text-sm font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-50">
                {probeLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Probe
              </button>
            </form>
            {probeError && <p className="mt-3 text-sm text-red-300">{probeError}</p>}
            {probeResults && (
              <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
                {probeResults.length ? (
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="border-b border-white/10 text-[11px] uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="px-3 py-3 text-left">Rank / similarity</th>
                        <th className="px-3 py-3 text-left">Entity</th>
                        <th className="px-3 py-3 text-left">Metadata</th>
                        <th className="px-3 py-3 text-left">Embedded text</th>
                        <th className="px-3 py-3 text-left">Evaluation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {probeResults.map((row, index) => (
                        <tr key={`${row.source_table}:${row.source_id}`} className="border-b border-white/5 last:border-0">
                          <td className="whitespace-nowrap px-3 py-3 align-top text-cyan-300">#{index + 1} · {(row.similarity * 100).toFixed(1)}%</td>
                          <td className="whitespace-nowrap px-3 py-3 align-top text-zinc-300">{labels[row.entity_type] ?? row.entity_type}<br /><span className="text-xs text-zinc-600">{row.source_table}:{row.source_id}</span></td>
                          <td className="max-w-[240px] px-3 py-3 align-top text-xs text-zinc-400">
                            {row.entity_type === "broker_alias" ? (
                              <>{String(row.metadata.alias || "Alias")}<br /><span className="text-zinc-500">{String(row.metadata.canonical_name || "Unlinked broker")}</span>{row.metadata.primary_phone && <><br /><span className="text-emerald-300">{String(row.metadata.primary_phone)}</span></>}</>
                            ) : String(row.metadata.summary_title || row.metadata.canonical_name || row.metadata.building_name || row.metadata.micro_market || "No display metadata")}
                          </td>
                          <td className="max-w-[420px] px-3 py-3 align-top text-xs leading-5 text-zinc-500">{row.content}</td>
                          <td className="px-3 py-3 align-top">
                            {evalCases.some((item) => item.query === probeQuery.trim() && item.source_table === row.source_table && item.source_id === row.source_id) ? (
                              <span className="text-xs text-emerald-300">Saved case</span>
                            ) : (
                              <button onClick={() => void saveEvalCase(row)} className="rounded-md border border-cyan-400/30 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-400/10">
                                Save as case
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="p-4 text-sm text-zinc-400">The real retrieval path returned no candidate above the similarity threshold.</p>}
              </div>
            )}
          </section>

          <section className="mb-6 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50">
            <div className="border-b border-white/10 px-5 py-4">
              <h2 className="font-semibold text-white">Coverage by entity</h2>
              <p className="mt-1 text-xs text-zinc-500">Stored vectors are counted separately from queue completion.</p>
            </div>
            {data.by_entity.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-zinc-500">
                    <tr className="border-b border-white/10">
                      <th className="px-5 py-3 text-left">Entity</th>
                      <th className="px-3 py-3 text-right">Queued</th>
                      <th className="px-3 py-3 text-right">Embedded</th>
                      <th className="px-3 py-3 text-right">Pending</th>
                      <th className="px-3 py-3 text-right">Running</th>
                      <th className="px-5 py-3 text-right">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_entity.map((row) => (
                      <tr key={row.entity_type} className="border-b border-white/5 last:border-0">
                        <td className="px-5 py-3 font-medium text-zinc-200">{labels[row.entity_type] ?? row.entity_type}</td>
                        <td className="px-3 py-3 text-right text-zinc-400">{row.total.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-emerald-300">{row.embedded.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-amber-300">{row.pending.toLocaleString()}</td>
                        <td className="px-3 py-3 text-right text-cyan-300">{row.running.toLocaleString()}</td>
                        <td className={`px-5 py-3 text-right ${row.failed ? "text-red-300" : "text-zinc-500"}`}>{row.failed.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-5 py-10 text-sm text-zinc-400">
                No entities have entered the semantic queue yet. New typed records and the bounded backfill will appear here automatically.
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <h2 className="flex items-center gap-2 font-semibold text-white">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Latest successful write
              </h2>
              <p className="mt-3 text-sm text-zinc-300">{dateTime(data.last_stored_at)}</p>
              <p className="mt-1 text-xs text-zinc-500">Latest completed queue job: {dateTime(data.last_completed_at)}</p>
            </section>
            <section className={`rounded-2xl border p-5 ${data.latest_failure ? "border-red-500/30 bg-red-500/5" : "border-white/10 bg-zinc-900/50"}`}>
              <h2 className="flex items-center gap-2 font-semibold text-white">
                {data.latest_failure ? <AlertTriangle className="h-4 w-4 text-red-400" /> : <Clock3 className="h-4 w-4 text-zinc-400" />}
                Latest failure
              </h2>
              {data.latest_failure ? (
                <>
                  <p className="mt-3 break-words text-sm text-red-200">{data.latest_failure.last_error}</p>
                  <p className="mt-2 text-xs text-zinc-500">
                    {labels[data.latest_failure.entity_type] ?? data.latest_failure.entity_type} · {data.latest_failure.source_table} · attempt {data.latest_failure.attempts} · {dateTime(data.latest_failure.updated_at)}
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm text-zinc-400">No failed semantic jobs are recorded.</p>
              )}
            </section>
          </div>

          <p className="mt-5 text-xs text-zinc-600">
            Snapshot generated {dateTime(data.generated_at)} · automatically refreshes every 60 seconds.
          </p>
        </>
      ) : null}
    </div>
  );
}

function QualityCheck({ label, value, note, good }: { label: string; value: number | string; note: string; good: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/40 p-3">
      <div className="flex items-center justify-between gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        {label}
        {good ? <CheckCircle2 className="h-4 w-4 text-emerald-400" /> : <XCircle className="h-4 w-4 text-amber-400" />}
      </div>
      <div className={`mt-1 text-xl font-bold ${good ? "text-emerald-300" : "text-amber-300"}`}>{typeof value === "number" ? value.toLocaleString() : value}</div>
      <div className="mt-1 text-xs text-zinc-600">{note}</div>
    </div>
  );
}

function AliasCheck({ label, check }: { label: string; check: { tested: number; hit_at_5: number; hit_rate_at_5: number } }) {
  const tested = Number(check?.tested || 0);
  const hit = Number(check?.hit_at_5 || 0);
  const rate = Number(check?.hit_rate_at_5 || 0);
  if (!tested) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-zinc-950/40 p-3">
        <div>
          <div className="text-sm text-zinc-300">{label}</div>
          <div className="mt-1 text-xs text-zinc-600">Measured by the golden retrieval evaluation below</div>
        </div>
        <div className="shrink-0 text-lg font-bold text-zinc-400">—</div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-zinc-950/40 p-3">
      <div>
        <div className="text-sm text-zinc-300">{label}</div>
        <div className="mt-1 text-xs text-zinc-600">{hit.toLocaleString()} of {tested.toLocaleString()} tested aliases found the canonical entity in top 5</div>
      </div>
      <div className={`shrink-0 text-lg font-bold ${tested && rate < 100 ? "text-amber-300" : "text-emerald-300"}`}>{tested ? `${rate.toFixed(1)}%` : "No tests"}</div>
    </div>
  );
}

function EvalMetric({ label, value, good, note }: { label: string; value: string; good: boolean | null; note: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">{label}</div>
      <div className={`mt-1 text-xl font-bold ${good === null ? "text-zinc-300" : good ? "text-emerald-300" : "text-red-300"}`}>{value}</div>
      <div className="mt-1 text-[11px] text-zinc-600">{note}</div>
    </div>
  );
}
