"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ChevronDown,
  Clock3,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { fetchJSON } from "@/lib/api";

type ProviderStatus = "up" | "degraded" | "down" | "unknown";

interface ProviderSummary {
  provider_id: number;
  provider_name: string;
  provider_type: string;
  model_name: string;
  base_url: string;
  is_active: boolean;
  tenant_id: string;
  status: ProviderStatus;
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
  overall: ProviderStatus;
  now_ts: number;
}

interface HistoryBucket {
  ts_bucket: number;
  ok_count: number;
  fail_count: number;
  total: number;
}

interface HistoryProvider {
  provider_id: number;
  provider_name: string;
  buckets: HistoryBucket[];
}

interface HistoryResponse {
  hours: number;
  bucket_minutes: number;
  providers: HistoryProvider[];
}

const STATUS: Record<ProviderStatus, { label: string; description: string; tone: string; mark: string }> = {
  up: {
    label: "Operational",
    description: "All active routes are responding",
    tone: "border-emerald-400/30 bg-emerald-400/[0.07] text-emerald-200",
    mark: "bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.55)]",
  },
  degraded: {
    label: "Degraded",
    description: "At least one route needs attention",
    tone: "border-amber-400/30 bg-amber-400/[0.07] text-amber-100",
    mark: "bg-amber-300 shadow-[0_0_18px_rgba(252,211,77,0.48)]",
  },
  down: {
    label: "Service disruption",
    description: "Active provider routes are failing",
    tone: "border-rose-400/35 bg-rose-500/[0.08] text-rose-100",
    mark: "bg-rose-400 shadow-[0_0_18px_rgba(251,113,133,0.5)]",
  },
  unknown: {
    label: "Awaiting evidence",
    description: "No recent probe result is available",
    tone: "border-white/15 bg-white/[0.035] text-zinc-200",
    mark: "bg-zinc-500",
  },
};

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function statusConfig(status: string) {
  return STATUS[(status in STATUS ? status : "unknown") as ProviderStatus];
}

function StatusMark({ status, pulse = false }: { status: string; pulse?: boolean }) {
  const config = statusConfig(status);
  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
      {pulse && status !== "unknown" ? (
        <span className={`absolute size-3 rounded-full opacity-40 motion-safe:animate-ping ${config.mark.split(" ")[0]}`} />
      ) : null}
      <span className={`relative size-2 rounded-full ${config.mark}`} />
    </span>
  );
}

function StatusTag({ status }: { status: string }) {
  const config = statusConfig(status);
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${config.tone}`}>
      <StatusMark status={status} />
      {config.label}
    </span>
  );
}

function fmtAgo(ts: string | null, now: number): string {
  if (!ts) return "No probe yet";
  const parsed = Date.parse(ts);
  if (!parsed || Number.isNaN(parsed)) return "Time unavailable";
  const seconds = Math.max(0, Math.round((now * 1000 - parsed) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function fmtBucket(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(11, 16) + "Z";
}

function fmtLatency(value: number): string {
  return value > 0 ? `${value.toLocaleString("en-IN")} ms` : "No sample";
}

function bucketTone(bucket: HistoryBucket): string {
  if (bucket.total === 0) return "bg-white/[0.06]";
  const successRate = bucket.ok_count / bucket.total;
  if (successRate === 1) return "bg-emerald-400/80";
  if (successRate >= 0.8) return "bg-amber-300/85";
  return "bg-rose-400/90";
}

function SignalTimeline({ buckets }: { buckets: HistoryBucket[] }) {
  if (buckets.length === 0) {
    return (
      <div className="flex h-9 items-center rounded-lg border border-dashed border-white/10 px-3 text-[11px] text-zinc-500">
        Probe history will appear after the first run.
      </div>
    );
  }

  const chronological = [...buckets].reverse();
  return (
    <div
      className="grid h-9 grid-flow-col auto-cols-fr items-stretch gap-[2px] overflow-hidden rounded-lg border border-white/10 bg-black/25 p-1"
      aria-label="Provider health timeline"
    >
      {chronological.map((bucket) => (
        <span
          key={bucket.ts_bucket}
          className={`min-w-[2px] rounded-[2px] ${bucketTone(bucket)}`}
          title={`${fmtBucket(bucket.ts_bucket)} · ${bucket.ok_count}/${bucket.total} successful`}
        />
      ))}
    </div>
  );
}

function Metric({ label, value, alert = false }: { label: string; value: string | number; alert?: boolean }) {
  return (
    <div className="min-w-0 border-l border-white/10 pl-4 first:border-l-0 first:pl-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold tabular-nums ${alert ? "text-amber-200" : "text-zinc-100"}`}>
        {value}
      </div>
    </div>
  );
}

function ProviderLane({
  provider,
  buckets,
  hours,
  now,
  probing,
  onProbe,
}: {
  provider: ProviderSummary;
  buckets: HistoryBucket[];
  hours: number;
  now: number;
  probing: boolean;
  onProbe: () => void;
}) {
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(Boolean(provider.last_error));
  const lastResult = provider.last_status || "no result";

  return (
    <motion.article
      layout={!reduceMotion}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
      className="group border-b border-white/[0.08] last:border-b-0"
      data-provider-status={provider.status}
    >
      <div className="grid gap-5 px-5 py-5 lg:grid-cols-[minmax(220px,1.1fr)_minmax(280px,1.5fr)_minmax(250px,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusMark status={provider.status} pulse={provider.status === "down" || provider.status === "degraded"} />
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-base font-semibold text-white">{provider.provider_name}</h2>
                {!provider.is_active ? (
                  <span className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-zinc-500">Inactive</span>
                ) : null}
              </div>
              <p className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={provider.model_name}>
                {provider.model_name || "Model not configured"}
              </p>
            </div>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-[0.15em] text-zinc-500">
            <span>{hours}h signal</span>
            <span>{buckets.length > 0 ? "Oldest → newest" : "No samples"}</span>
          </div>
          <SignalTimeline buckets={buckets} />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Metric label="Probes" value={provider.probe_count} />
          <Metric label="Median" value={fmtLatency(provider.p50_ms)} />
          <Metric label="Tail" value={fmtLatency(provider.p95_ms)} alert={provider.p95_ms > 5000} />
        </div>

        <div className="flex items-center gap-2 lg:justify-end">
          <button
            type="button"
            onClick={onProbe}
            disabled={probing}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-3 text-xs font-medium text-zinc-200 transition hover:border-white/25 hover:bg-white/[0.08] disabled:cursor-wait disabled:opacity-50"
          >
            <RefreshCw className={`size-3.5 ${probing ? "animate-spin" : ""}`} />
            {probing ? "Probing" : "Probe"}
          </button>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} evidence for ${provider.provider_name}`}
            className="grid size-9 place-items-center rounded-lg border border-transparent text-zinc-500 transition hover:border-white/10 hover:bg-white/[0.04] hover:text-white"
          >
            <ChevronDown className={`size-4 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="grid gap-4 border-t border-white/[0.06] bg-black/20 px-5 py-4 md:grid-cols-[1fr_2fr]">
              <div>
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Last execution</div>
                <div className="mt-2 flex items-center gap-2 text-sm text-zinc-200">
                  <StatusMark status={provider.status} />
                  <span className="capitalize">{lastResult.replaceAll("_", "-")}</span>
                  <span className="text-zinc-600">·</span>
                  <span className="text-zinc-400">{fmtAgo(provider.last_probe_ts, now)}</span>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  {provider.provider_type.toUpperCase()} route · {provider.is_active ? "active configuration" : "inactive configuration"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-zinc-500">Failure evidence</div>
                {provider.last_error ? (
                  <div className="mt-2 rounded-lg border border-rose-400/20 bg-rose-500/[0.06] px-3 py-2.5 font-mono text-xs leading-5 text-rose-100/90">
                    <div className="mb-1 flex items-center justify-between gap-4">
                      <span className="font-semibold uppercase tracking-wider text-rose-300">{provider.last_error.error_kind || provider.last_error.status}</span>
                      <span className="font-sans text-[10px] text-zinc-500">{fmtAgo(provider.last_error.ts, now)}</span>
                    </div>
                    <p className="break-words text-zinc-300">{provider.last_error.error_msg || "No error body was returned."}</p>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-zinc-500">No failure is attached to the latest provider state.</p>
                )}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
}

export function AdminProvidersPage() {
  const reduceMotion = useReducedMotion();
  const [health, setHealth] = useState<ProviderHealthResponse | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [probingId, setProbingId] = useState<number | null>(null);
  const [tickNow, setTickNow] = useState<number | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async (): Promise<ProviderHealthResponse | null> => {
    try {
      const [nextHealth, nextHistory] = await Promise.all([
        fetchJSON<ProviderHealthResponse>("/admin/providers/health"),
        fetchJSON<HistoryResponse>(`/admin/providers/history?hours=${hours}&bucket_minutes=5`),
      ]);
      setHealth(nextHealth);
      setHistory(nextHistory);
      setError(null);
      return nextHealth;
    } catch (caught) {
      setError(errMessage(caught) || "Provider evidence could not be loaded.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    const initial = setTimeout(() => { void load(); }, 0);
    const interval = setInterval(() => { void load(); }, 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => setTickNow(Date.now() / 1000), 1000);
    return () => clearInterval(interval);
  }, []);

  const nowTs = health?.now_ts ?? tickNow ?? 0;
  const visibleProviders = useMemo(() => {
    const providers = health?.providers || [];
    const rows = showInactive ? providers : providers.filter((provider) => provider.is_active);
    return [...rows].sort((left, right) => {
      if (left.is_active !== right.is_active) return Number(right.is_active) - Number(left.is_active);
      const rank: Record<ProviderStatus, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
      if (left.status !== right.status) return rank[left.status] - rank[right.status];
      return left.provider_name.localeCompare(right.provider_name);
    });
  }, [health?.providers, showInactive]);

  const counts = useMemo(() => {
    const providers = health?.providers.filter((provider) => provider.is_active) || [];
    return {
      active: providers.length,
      healthy: providers.filter((provider) => provider.status === "up").length,
      attention: providers.filter((provider) => provider.status === "down" || provider.status === "degraded").length,
      unknown: providers.filter((provider) => provider.status === "unknown").length,
    };
  }, [health?.providers]);

  const failures = (health?.providers || []).filter((provider) => provider.last_error);
  const overall = statusConfig(health?.overall || "unknown");

  async function probeNow(providerId: number) {
    setProbingId(providerId);
    try {
      await fetchJSON(`/admin/providers/probe/${providerId}`, { method: "POST" });
      await load();
    } catch (caught) {
      setError(errMessage(caught) || "The provider probe failed.");
    } finally {
      setProbingId(null);
    }
  }

  async function cleanupOld() {
    if (!confirm("Delete provider outage evidence older than 7 days?")) return;
    try {
      await fetchJSON("/admin/providers/cleanup", {
        method: "POST",
        body: JSON.stringify({ retention_days: 7 }),
      });
      await load();
    } catch (caught) {
      setError(errMessage(caught) || "Old provider evidence could not be removed.");
    }
  }

  return (
    <main className="propai-provider-page mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-7 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <Link
            href="/admin"
            aria-label="Back to admin"
            className="mt-1 grid size-9 shrink-0 place-items-center rounded-full border border-white/10 text-zinc-500 transition hover:border-white/20 hover:bg-white/[0.04] hover:text-white"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">
              <span className="h-px w-8 bg-zinc-700" />
              Runtime intelligence
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Provider signal room</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
              Live execution evidence for every configured LLM route. Probes run every 60 seconds; failure payloads remain inspectable.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setShowInactive((value) => !value)}
            aria-pressed={showInactive}
            className={`h-9 rounded-lg border px-3 text-xs font-medium transition ${
              showInactive
                ? "border-white/25 bg-white/[0.09] text-white"
                : "border-white/10 bg-white/[0.03] text-zinc-400 hover:border-white/20 hover:text-white"
            }`}
          >
            {showInactive ? "All configurations" : "Active routes"}
          </button>
          <label className="sr-only" htmlFor="provider-history-range">Timeline range</label>
          <select
            id="provider-history-range"
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
            className="h-9 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs text-zinc-200 outline-none transition focus:border-white/30"
          >
            <option value={1}>Last hour</option>
            <option value={6}>Last 6 hours</option>
            <option value={24}>Last 24 hours</option>
            <option value={168}>Last 7 days</option>
          </select>
          <button
            type="button"
            onClick={() => { void load(); }}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan-300/25 bg-cyan-300/[0.07] px-3 text-xs font-semibold text-cyan-100 transition hover:border-cyan-200/40 hover:bg-cyan-300/[0.12]"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh evidence
          </button>
          <button
            type="button"
            onClick={() => { void cleanupOld(); }}
            title="Delete provider evidence older than 7 days"
            className="grid size-9 place-items-center rounded-lg border border-white/10 text-zinc-500 transition hover:border-rose-400/25 hover:bg-rose-500/[0.06] hover:text-rose-200"
          >
            <Trash2 className="size-3.5" />
            <span className="sr-only">Clean up old evidence</span>
          </button>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {error ? (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: reduceMotion ? 0 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mb-5 flex items-start gap-3 rounded-xl border border-rose-400/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-100"
            role="alert"
          >
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-rose-300" />
            <div>
              <div className="font-semibold">Provider evidence unavailable</div>
              <div className="mt-0.5 text-rose-100/70">{error}</div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {!health && loading ? (
        <section className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/40" aria-live="polite">
          <div className="flex min-h-56 items-center justify-center">
            <div className="flex items-center gap-3 text-sm text-zinc-500">
              <span className="relative flex size-3">
                <span className="absolute size-3 animate-ping rounded-full bg-cyan-300/30" />
                <span className="relative m-1 size-1 rounded-full bg-cyan-200" />
              </span>
              Reading live provider signals
            </div>
          </div>
        </section>
      ) : health ? (
        <>
          <section className={`mb-5 overflow-hidden rounded-2xl border ${overall.tone}`}>
            <div className="grid gap-6 px-5 py-5 md:grid-cols-[1.4fr_repeat(4,minmax(90px,0.45fr))] md:items-center md:px-6">
              <div className="flex items-center gap-4">
                <div className="relative grid size-12 shrink-0 place-items-center rounded-full border border-current/20 bg-black/20">
                  <span className={`size-3 rounded-full ${overall.mark}`} />
                  <span className="absolute inset-1 rounded-full border border-current/10" />
                </div>
                <div>
                  <StatusTag status={health.overall} />
                  <p className="mt-2 text-sm text-current/70">{overall.description}</p>
                </div>
              </div>
              <Metric label="Active" value={counts.active} />
              <Metric label="Healthy" value={counts.healthy} />
              <Metric label="Attention" value={counts.attention} alert={counts.attention > 0} />
              <Metric label="No evidence" value={counts.unknown} />
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/45 shadow-[0_24px_80px_rgba(0,0,0,0.22)]">
            <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
              <div>
                <h2 className="text-sm font-semibold text-white">Execution routes</h2>
                <p className="mt-1 text-xs text-zinc-500">Unhealthy and unknown routes are shown first.</p>
              </div>
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                <Clock3 className="size-3.5" />
                Auto-refresh 30s
              </div>
            </div>

            {visibleProviders.map((provider) => (
              <ProviderLane
                key={provider.provider_id}
                provider={provider}
                buckets={history?.providers.find((entry) => entry.provider_id === provider.provider_id)?.buckets || []}
                hours={hours}
                now={nowTs}
                probing={probingId === provider.provider_id}
                onProbe={() => { void probeNow(provider.provider_id); }}
              />
            ))}

            {visibleProviders.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <p className="text-sm font-medium text-zinc-300">No provider routes are configured in this view.</p>
                <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-zinc-500">
                  Add a route in <Link href="/workspace/llm-providers" className="text-cyan-200 underline decoration-cyan-300/30 underline-offset-4">AI Providers</Link>, or show inactive configurations.
                </p>
              </div>
            ) : null}
          </section>

          {failures.length > 0 ? (
            <section className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/35">
              <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
                <div>
                  <h2 className="text-sm font-semibold text-white">Latest failure ledger</h2>
                  <p className="mt-1 text-xs text-zinc-500">One latest failure per configured provider.</p>
                </div>
                <span className="rounded-full border border-rose-400/20 bg-rose-500/[0.06] px-2.5 py-1 text-[10px] font-semibold text-rose-200">
                  {failures.length} {failures.length === 1 ? "event" : "events"}
                </span>
              </div>
              <div className="divide-y divide-white/[0.06]">
                {failures.map((provider) => (
                  <div key={provider.provider_id} className="grid gap-2 px-5 py-4 text-sm md:grid-cols-[130px_180px_130px_1fr] md:items-start">
                    <span className="font-mono text-xs text-zinc-500">{fmtAgo(provider.last_error!.ts, nowTs)}</span>
                    <span className="font-medium text-zinc-100">{provider.provider_name}</span>
                    <span className="w-fit rounded border border-rose-400/20 bg-rose-500/[0.06] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-rose-200">
                      {provider.last_error!.error_kind || provider.last_error!.status}
                    </span>
                    <span className="break-words font-mono text-xs leading-5 text-zinc-400">{provider.last_error!.error_msg || "No error body returned"}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}

export default function LegacyAdminProvidersPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/admin/pipeline-health?tab=providers"); }, [router]);
  return null;
}
