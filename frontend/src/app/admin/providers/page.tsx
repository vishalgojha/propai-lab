"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowLeft, Activity, AlertTriangle, CheckCircle2, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface ProviderSummary {
  provider_id: number;
  provider_name: string;
  provider_type: string;
  model_name: string;
  base_url: string;
  is_active: boolean;
  tenant_id: string;
  status: "up" | "degraded" | "down" | "unknown";
  probe_count: number;
  p50_ms: number;
  p95_ms: number;
  last_probe_ts: string | null;
  last_status: string | null;
  last_latency_ms: number;
  last_error: {
    status: string;
    ts: string;
    error_kind: string;
    error_msg: string;
  } | null;
}

interface ProviderHealthResponse {
  providers: ProviderSummary[];
  overall: "up" | "degraded" | "down" | "unknown";
  now_ts: number;
}

interface HistoryBucket {
  ts_bucket: number;
  ok_count: number;
  fail_count: number;
  total: number;
}

interface HistoryProvider {
  provider_name: string;
  buckets: HistoryBucket[];
}

interface HistoryResponse {
  hours: number;
  bucket_minutes: number;
  providers: HistoryProvider[];
}

const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  up: { label: "UP", cls: "bg-emerald-400/10 text-emerald-300 border-emerald-400/30" },
  degraded: { label: "DEGRADED", cls: "bg-orange-400/10 text-orange-300 border-orange-400/30" },
  down: { label: "DOWN", cls: "bg-red-500/10 text-red-300 border-red-500/30" },
  unknown: { label: "NO DATA", cls: "bg-zinc-700/30 text-zinc-300 border-zinc-500/30" },
};

const PROBE_DOT: Record<string, string> = {
  ok: "bg-emerald-400",
  slow: "bg-orange-400",
  timeout: "bg-red-400",
  http: "bg-red-500",
  error: "bg-red-600",
};


function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "";
}

function StatusPill({ status }: { status: string }) {
  const cfg = STATUS_PILL[status] ?? STATUS_PILL.unknown;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "up") return <CheckCircle2 className="w-5 h-5 text-emerald-400" />;
  if (status === "degraded") return <AlertTriangle className="w-5 h-5 text-orange-400" />;
  if (status === "down") return <AlertTriangle className="w-5 h-5 text-red-400" />;
  return <Activity className="w-5 h-5 text-zinc-500" />;
}

function fmtAgo(ts: string | null, now: number): string {
  if (!ts) return "—";
  const t = Date.parse(ts);
  if (!t || Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.round((now * 1000 - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function fmtBucket(epoch: number): string {
  const d = new Date(epoch * 1000);
  return d.toISOString().slice(11, 16) + "Z";
}

function TimelineStrip({ buckets, now }: { buckets: HistoryBucket[]; now: number }) {
  if (!buckets || buckets.length === 0) {
    return <div className="text-xs text-zinc-500 italic">No probe history</div>;
  }
  const oldest = buckets[buckets.length - 1]?.ts_bucket ?? now;
  const newest = buckets[0]?.ts_bucket ?? now;
  const span = Math.max(newest - oldest, 1);
  return (
    <div className="flex h-6 gap-px rounded overflow-hidden bg-zinc-900/60 border border-white/10" title="5-min buckets, newest first">
      {buckets.map((b) => {
        const ratio = (b.ts_bucket - oldest) / span;
        const ok = b.total > 0 ? b.ok_count / b.total : 1;
        const color =
          b.total === 0 ? "bg-zinc-800" :
          ok === 1 ? "bg-emerald-500" :
          ok >= 0.8 ? "bg-orange-400" :
          "bg-red-500";
        const left = `${(ratio * 100).toFixed(2)}%`;
        const widthPct = Math.max(100 / buckets.length, 0.5);
        return (
          <div
            key={b.ts_bucket}
            className={`${color} opacity-90`}
            style={{
              position: "relative",
              left,
              width: `${widthPct}%`,
              minWidth: 3,
            }}
            title={`${fmtBucket(b.ts_bucket)} — ${b.ok_count}/${b.total} ok`}
          />
        );
      })}
    </div>
  );
}

export default function AdminProvidersPage() {
  const [health, setHealth] = useState<ProviderHealthResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [probingId, setProbingId] = useState<number | null>(null);
  const [tickNow, setTickNow] = useState<number | null>(null);

  const load = useCallback(async (): Promise<ProviderHealthResponse | null> => {
    try {
      const [h, hist] = await Promise.all([
        fetchJSON<ProviderHealthResponse>("/admin/providers/health"),
        fetchJSON<HistoryResponse>(`/admin/providers/history?hours=${hours}&bucket_minutes=5`),
      ]);
      setHealth(h);
      setHistory(hist);
      setError(null);
      return h;
    } catch (e) {
      setError(errMessage(e) || "Failed to load provider health");
      return null;
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    load();
    const interval = setInterval(() => { load(); }, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const tickInterval = setInterval(() => setTickNow(Date.now() / 1000), 1000);
    return () => clearInterval(tickInterval);
  }, []);

  const nowTs = health?.now_ts ?? tickNow ?? 0;

  async function probeNow(providerId: number) {
    setProbingId(providerId);
    try {
      await fetchJSON(`/admin/providers/probe/${providerId}`, { method: "POST" });
      await load();
    } catch (e) {
      alert(errMessage(e) || "Probe failed");
    } finally {
      setProbingId(null);
    }
  }

  async function cleanupOld() {
    if (!confirm("Delete outage log rows older than 7 days?")) return;
    try {
      await fetchJSON("/admin/providers/cleanup", {
        method: "POST",
        body: JSON.stringify({ retention_days: 7 }),
      });
      await load();
    } catch (e) {
      alert(errMessage(e) || "Cleanup failed");
    }
  }

  const failures = (health?.providers || [])
    .filter((p) => p.last_error)
    .map((p) => ({ provider: p, error: p.last_error! }));

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-zinc-400 hover:text-white">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Sparkles className="w-6 h-6 text-cyan-400" />
              Provider Health
            </h1>
            <p className="text-sm text-zinc-500">Outage evidence for every configured LLM. Probed every 60s.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm text-white focus:border-cyan-400 focus:outline-none"
          >
            <option value={1}>Last 1h</option>
            <option value={6}>Last 6h</option>
            <option value={24}>Last 24h</option>
            <option value={168}>Last 7d</option>
          </select>
          <button
            onClick={() => load()}
            className="flex items-center gap-1 px-3 py-2 bg-cyan-400/10 text-cyan-300 hover:bg-cyan-400/20 border border-cyan-400/30 rounded-lg text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
          <button
            onClick={cleanupOld}
            className="flex items-center gap-1 px-3 py-2 bg-zinc-800 text-zinc-400 hover:text-white border border-white/10 rounded-lg text-sm"
            title="Delete outage rows older than 7 days"
          >
            <Trash2 className="w-4 h-4" />
            Cleanup
          </button>
        </div>
      </div>

      {loading && !health ? (
        <div className="text-center py-12 text-zinc-500">Loading…</div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300">{error}</div>
      ) : (
        <>
          {/* Overall status banner */}
          {health && (
            <div className={`mb-6 p-4 rounded-2xl border ${
              health.overall === "up" ? "border-emerald-400/30 bg-emerald-400/5" :
              health.overall === "degraded" ? "border-orange-400/30 bg-orange-400/5" :
              health.overall === "down" ? "border-red-500/30 bg-red-500/5" :
              "border-zinc-500/30 bg-zinc-700/10"
            }`}>
              <div className="flex items-center gap-3">
                <StatusIcon status={health.overall} />
                <div>
                  <div className="text-white font-semibold">
                    Overall: <StatusPill status={health.overall} />
                  </div>
                  <div className="text-xs text-zinc-400 mt-1">
                    {health.providers.length} provider{health.providers.length === 1 ? "" : "s"} configured · probing every 60s
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Provider cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 mb-8">
            {(health?.providers || []).map((p) => {
              const buckets = (history?.providers.find((h) => h.provider_name === p.provider_name)?.buckets) ?? [];
              return (
                <div key={p.provider_id} className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5 flex flex-col gap-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <StatusIcon status={p.status} />
                      <div>
                        <div className="text-white font-semibold text-sm">{p.provider_name}</div>
                        <div className="text-[10px] text-zinc-500 uppercase">{p.provider_type} · {p.is_active ? "active" : "inactive"}</div>
                      </div>
                    </div>
                    <StatusPill status={p.status} />
                  </div>
                  <div className="text-xs text-zinc-400 font-mono truncate" title={p.model_name}>{p.model_name || "—"}</div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">Probes 30m</div>
                      <div className="text-white font-semibold">{p.probe_count}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">p50</div>
                      <div className="text-white font-semibold">{p.p50_ms ? `${p.p50_ms}ms` : "—"}</div>
                    </div>
                    <div>
                      <div className="text-zinc-500 text-[10px] uppercase">p95</div>
                      <div className={`font-semibold ${p.p95_ms > 5000 ? "text-orange-300" : "text-white"}`}>{p.p95_ms ? `${p.p95_ms}ms` : "—"}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-zinc-400">
                    <span className={`w-2 h-2 rounded-full ${PROBE_DOT[p.last_status || "error"] || "bg-zinc-600"}`} />
                    <span>{p.last_status || "no-data"}</span>
                    <span>·</span>
                    <span>{fmtAgo(p.last_probe_ts, nowTs)}</span>
                  </div>
                  {p.last_error && (
                    <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-xs">
                      <div className="text-red-300 font-mono">{p.last_error.error_kind || "error"}</div>
                      <div className="text-zinc-400 truncate" title={p.last_error.error_msg}>{p.last_error.error_msg || "—"}</div>
                      <div className="text-zinc-500 text-[10px] mt-1">{fmtAgo(p.last_error.ts, nowTs)}</div>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] text-zinc-500 uppercase mb-1">{hours}h timeline</div>
                    <TimelineStrip buckets={buckets} now={nowTs} />
                  </div>
                  <button
                    onClick={() => probeNow(p.provider_id)}
                    disabled={probingId === p.provider_id}
                    className="mt-1 flex items-center justify-center gap-1 px-3 py-2 bg-cyan-400/10 text-cyan-300 hover:bg-cyan-400/20 border border-cyan-400/30 rounded-lg text-xs font-medium disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${probingId === p.provider_id ? "animate-spin" : ""}`} />
                    {probingId === p.provider_id ? "Probing…" : "Probe now"}
                  </button>
                </div>
              );
            })}
            {(!health || health.providers.length === 0) && (
              <div className="col-span-full rounded-xl border border-white/10 bg-zinc-900/30 p-8 text-center text-zinc-500">
                No LLM providers configured. Add one in <Link href="/workspace/llm-providers" className="text-cyan-400 hover:underline">AI Providers</Link> to start tracking outage evidence.
              </div>
            )}
          </div>

          {/* Recent failures table */}
          {failures.length > 0 && (
            <section className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                Recent Failures
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] text-zinc-500 uppercase tracking-wider">
                      <th className="text-left px-3 py-2">When</th>
                      <th className="text-left px-3 py-2">Provider</th>
                      <th className="text-left px-3 py-2">Kind</th>
                      <th className="text-left px-3 py-2">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {failures.map((row, i) => (
                      <tr key={`${row.provider.provider_id}-${i}`} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 text-zinc-400 font-mono text-xs whitespace-nowrap">
                          {fmtAgo(row.error.ts, nowTs)}
                        </td>
                        <td className="px-3 py-2 text-white">{row.provider.provider_name}</td>
                        <td className="px-3 py-2">
                          <span className="px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-300 text-[10px] font-bold uppercase">
                            {row.error.error_kind || row.error.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-zinc-300 font-mono text-xs truncate max-w-md" title={row.error.error_msg}>
                          {row.error.error_msg || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
