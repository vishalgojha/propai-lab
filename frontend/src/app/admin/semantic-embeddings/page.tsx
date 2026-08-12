"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
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

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => load(true), 15000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const coverage = useMemo(() => {
    if (!data?.jobs.total) return 0;
    return Math.min(100, (data.vectors.total / data.jobs.total) * 100);
  }, [data]);

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
            <StatCard label="Stored vectors" value={data.vectors.total} note="Actually searchable rows" tone="text-emerald-300" />
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
              <span>{data.vectors.total.toLocaleString()} vectors stored from {data.jobs.total.toLocaleString()} queued entities</span>
              <span>Last stored: {dateTime(data.last_stored_at)}</span>
            </div>
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
            Snapshot generated {dateTime(data.generated_at)} · automatically refreshes every 15 seconds.
          </p>
        </>
      ) : null}
    </div>
  );
}
