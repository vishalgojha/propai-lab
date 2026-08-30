"use client";

export const dynamic = "force-dynamic";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, ArrowLeft, Database, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Timer, Zap } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type TableRow = { name: string; group_name: string; row_count: number; rls_enabled: boolean; policy_count: number; last_analyzed_at: string | null; approximate_size_bytes: number; is_legacy: boolean };
type FunctionRow = { name: string; arguments: string; security_definer: boolean; anon_execute: boolean; authenticated_execute: boolean; service_role_execute: boolean; should_be_public: boolean };
type QualityRow = { table_name: string; missing_source_rows?: number; duplicate_key_groups?: number; needs_review?: number; duplicate_flagged?: number; locality_resolved_rows?: number; locality_total_rows?: number };
type Snapshot = { generated_at: string; tables: TableRow[]; rls_zero_policy: { name: string; row_count: number }[]; functions: FunctionRow[]; queues: Record<string, unknown>; quality: QualityRow[]; locality_resolution: { resolved_rows: number; total_rows: number; rate_pct: number | null }; indexes: { unused: Record<string, unknown>[]; duplicate: Record<string, unknown>[]; missing_fk_indexes: Record<string, unknown>[] } };

const GROUPS = ["all", "extraction / typed listings", "WhatsApp ingestion", "broker / CRM", "embeddings / semantic", "jobs / queues", "auth / org", "legacy", "other"];

function number(value: unknown) { return Number(value || 0).toLocaleString("en-IN"); }
function bytes(value: unknown) { const n = Number(value || 0); if (n < 1024) return `${n} B`; if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`; if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`; return `${(n / 1024 ** 3).toFixed(1)} GB`; }
function when(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not tracked"; }

function Status({ tone, children }: { tone: "healthy" | "warning" | "critical"; children: ReactNode }) {
  const classes = tone === "healthy" ? "border-[#2f6b3a]/30 bg-[#2f6b3a]/10 text-[#2f6b3a]" : tone === "warning" ? "border-[#8a5a00]/35 bg-[#8a5a00]/10 text-[#8a5a00]" : "border-[#a9362e]/30 bg-[#a9362e]/10 text-[#a9362e]";
  return <Badge variant="outline" className={classes}>{children}</Badge>;
}

function Section({ title, icon: Icon, refreshed, onRefresh, children }: { title: string; icon: typeof Database; refreshed: string | null; onRefresh: () => void; children: ReactNode }) {
  return <section className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-[var(--monsoon-teal)]" /><h2 className="text-[15px] font-semibold text-[var(--asphalt)]">{title}</h2></div>
      <div className="flex items-center gap-3 text-[11px] text-[#49615F]"><span>Last refreshed: {refreshed ? when(refreshed) : "—"}</span><Button variant="ghost" size="sm" onClick={onRefresh} className="h-7 px-2 text-[#287D82]"><RefreshCw className="h-3.5 w-3.5" />Refresh</Button></div>
    </div>
    {children}
  </section>;
}

function Metric({ label, value, note, tone = "normal" }: { label: string; value: string; note: string; tone?: "normal" | "warning" | "critical" }) {
  return <Card className="border-[rgba(22,37,43,.12)] bg-[#F6FBF9] p-4 shadow-[0_6px_16px_rgba(22,37,43,.05)]"><div className="text-[10px] font-semibold uppercase tracking-[.14em] text-[#49615F]">{label}</div><div className={`mt-1 text-[24px] font-semibold tracking-[-.04em] ${tone === "critical" ? "text-[#A9362E]" : tone === "warning" ? "text-[#8A5A00]" : "text-[#16252B]"}`}>{value}</div><div className="mt-1 text-[11px] text-[#49615F]">{note}</div></Card>;
}

export default function SupabaseObservabilityPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [sort, setSort] = useState<"name" | "rows" | "size">("name");

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true); setError(null);
    try { setData(await fetchJSON<Snapshot>("/admin/supabase-observability")); }
    catch (e) { setError(e instanceof Error ? e.message : "Live observability snapshot could not be loaded"); }
    finally { quiet ? setRefreshing(false) : setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const tables = useMemo(() => (data?.tables || []).filter((row) => (!query || row.name.toLowerCase().includes(query.toLowerCase())) && (group === "all" || row.group_name === group)).sort((a, b) => sort === "rows" ? b.row_count - a.row_count : sort === "size" ? b.approximate_size_bytes - a.approximate_size_bytes : a.name.localeCompare(b.name)), [data, group, query, sort]);
  const quality = data?.quality || [];
  const sourceViolations = quality.reduce((sum, row) => sum + Number(row.missing_source_rows || 0), 0);
  const duplicateKeys = quality.reduce((sum, row) => sum + Number(row.duplicate_key_groups || 0), 0);
  const reviewRows = quality.reduce((sum, row) => sum + Number(row.needs_review || 0), 0);
  const flaggedRows = quality.reduce((sum, row) => sum + Number(row.duplicate_flagged || 0), 0);
  const queues = data?.queues || {};
  const attempts = (queues.attempt_log || {}) as Record<string, number>;
  const heartbeats = Array.isArray(queues.heartbeats) ? queues.heartbeats as Record<string, unknown>[] : [];
  const staleHeartbeats = heartbeats.filter((row) => row.status !== "running").length;

  if (loading) return <main className="min-h-screen bg-[#DDE8E5] p-8 text-sm text-[#49615F]">Loading live Supabase observability…</main>;
  if (error || !data) return <main className="min-h-screen bg-[#DDE8E5] p-8"><Card className="mx-auto max-w-2xl border-[#A9362E]/30 bg-[#FFF7F5] p-6 text-[#7D2B25]"><h1 className="font-semibold">Observability snapshot unavailable</h1><p className="mt-2 text-sm">{error || "No snapshot returned"}</p><Button className="mt-4" onClick={() => load()}>Try again</Button></Card></main>;

  return <main className="min-h-[calc(100dvh-44px)] bg-[#DDE8E5] px-4 py-6 text-[#16252B] sm:px-8 lg:px-10">
    <div className="mx-auto max-w-[1500px] space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-5 border-b border-[rgba(22,37,43,.14)] pb-6">
        <div><Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-xs text-[#49615F] hover:text-[#16252B]"><ArrowLeft className="h-3.5 w-3.5" />Super Admin</Link><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#16252B] text-[#8BCB68]"><Database className="h-5 w-5" /></div><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#287D82]">Platform observability</p><h1 className="text-2xl font-semibold tracking-[-.035em]">Supabase database</h1></div></div><p className="mt-3 max-w-2xl text-sm text-[#49615F]">A read-only catalog view of schema exposure, queue pressure, source integrity, and index risk. Table row counts are catalog estimates; quality signals remain live database checks.</p></div>
        <div className="flex items-center gap-3"><div className="text-right text-[11px] text-[#49615F]"><div className="flex items-center justify-end gap-1.5"><span className="h-2 w-2 rounded-full bg-[#2F6B3A]" />Live snapshot</div><div className="mt-1">{when(data.generated_at)}</div></div><Button onClick={() => load(true)} disabled={refreshing} className="bg-[#16252B] text-[#DDE8E5] hover:bg-[#287D82]"><RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />Refresh all</Button></div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Public tables" value={number(data.tables.length)} note="Catalog relations in public schema" />
        <Metric label="RLS gaps" value={number(data.rls_zero_policy.length)} note="RLS enabled, zero policies" tone={data.rls_zero_policy.length ? "critical" : "normal"} />
        <Metric label="Locality resolved" value={`${data.locality_resolution.rate_pct ?? 0}%`} note={`${number(data.locality_resolution.resolved_rows)} of ${number(data.locality_resolution.total_rows)} typed rows`} tone={(data.locality_resolution.rate_pct ?? 0) < 80 ? "warning" : "normal"} />
        <Metric label="Source violations" value={number(sourceViolations)} note="Typed raw_message_id not found" tone={sourceViolations ? "critical" : "normal"} />
        <Metric label="Worker attention" value={number(staleHeartbeats)} note={`${number(heartbeats.length)} heartbeat records observed`} tone={staleHeartbeats ? "warning" : "normal"} />
      </div>

      <Section title="Table inventory" icon={Database} refreshed={data.generated_at} onRefresh={() => load(true)}>
        <Card className="overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9] shadow-[0_8px_22px_rgba(22,37,43,.05)]">
          <div className="flex flex-wrap gap-2 border-b border-[rgba(22,37,43,.1)] p-3"><label className="relative min-w-[230px] flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-[#49615F]" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tables" className="h-9 w-full rounded-md border border-[rgba(22,37,43,.16)] bg-white pl-9 pr-3 text-sm text-[#16252B] outline-none focus:border-[#287D82] focus:ring-2 focus:ring-[#287D82]/25" /></label><select value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 rounded-md border border-[rgba(22,37,43,.16)] bg-white px-3 text-xs text-[#16252B] outline-none focus:border-[#287D82]">{GROUPS.map((item) => <option key={item} value={item}>{item === "all" ? "All groups" : item}</option>)}</select><select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="h-9 rounded-md border border-[rgba(22,37,43,.16)] bg-white px-3 text-xs text-[#16252B] outline-none focus:border-[#287D82]"><option value="name">Sort: name</option><option value="rows">Sort: rows</option><option value="size">Sort: size</option></select><div className="flex items-center gap-1 px-2 text-[11px] text-[#49615F]"><SlidersHorizontal className="h-3.5 w-3.5" />{number(tables.length)} shown</div></div>
          <div className="max-h-[560px] overflow-auto"><table className="w-full min-w-[850px] text-left text-xs"><thead className="sticky top-0 bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr><th className="px-4 py-3">Table</th><th className="px-4 py-3">Rows</th><th className="px-4 py-3">RLS</th><th className="px-4 py-3">Policies</th><th className="px-4 py-3">Approx. size</th><th className="px-4 py-3">Last analyzed</th></tr></thead><tbody>{tables.map((row) => <tr key={row.name} className="border-t border-[rgba(22,37,43,.08)] hover:bg-white"><td className="px-4 py-3"><div className="flex items-center gap-2 font-mono text-[12px] text-[#16252B]">{row.name}{row.is_legacy && <Status tone="warning">LEGACY</Status>}</div><div className="mt-1 text-[10px] text-[#49615F]">{row.group_name}</div></td><td className="px-4 py-3 font-mono text-[#16252B]">{number(row.row_count)}</td><td className="px-4 py-3">{row.rls_enabled ? <Status tone={row.policy_count ? "healthy" : "critical"}>{row.policy_count ? "enabled" : "gap"}</Status> : <Status tone="warning">disabled</Status>}</td><td className="px-4 py-3 font-mono text-[#16252B]">{number(row.policy_count)}</td><td className="px-4 py-3 text-[#49615F]">{bytes(row.approximate_size_bytes)}</td><td className="px-4 py-3 text-[#49615F]">{when(row.last_analyzed_at)}</td></tr>)}</tbody></table></div>
        </Card>
      </Section>

      <div className="grid gap-8 xl:grid-cols-2">
        <Section title="RLS and function security" icon={ShieldAlert} refreshed={data.generated_at} onRefresh={() => load(true)}>
          {data.rls_zero_policy.length > 0 && <Card className="border-[#A9362E]/25 bg-[#FFF7F5] p-4"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#A9362E]" /><div><div className="text-sm font-semibold text-[#7D2B25]">{number(data.rls_zero_policy.length)} RLS gaps require review</div><p className="mt-1 text-xs text-[#7D2B25]">RLS is enabled but no policy is attached; service-role workers may be intentional, but these must be explicitly reviewed.</p><div className="mt-3 flex flex-wrap gap-1.5">{data.rls_zero_policy.slice(0, 30).map((row) => <Badge key={row.name} variant="outline" className="border-[#A9362E]/25 text-[#7D2B25]">{row.name} · {number(row.row_count)}</Badge>)}</div></div></div></Card>}
          <Card className="overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9]"><div className="border-b border-[rgba(22,37,43,.1)] px-4 py-3 text-[11px] text-[#49615F]">SECURITY DEFINER inventory · should-public flags make accidental RPC exposure visible</div><div className="max-h-[360px] overflow-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr><th className="px-4 py-3">Function</th><th className="px-4 py-3">Definer</th><th className="px-4 py-3">anon / auth</th><th className="px-4 py-3">Should public?</th></tr></thead><tbody>{data.functions.filter((row) => row.security_definer).map((row) => <tr key={`${row.name}-${row.arguments}`} className="border-t border-[rgba(22,37,43,.08)]"><td className="px-4 py-3 font-mono text-[#16252B]">{row.name}<span className="ml-1 text-[10px] text-[#49615F]">({row.arguments})</span></td><td className="px-4 py-3"><Status tone="warning">SECURITY DEFINER</Status></td><td className="px-4 py-3 text-[#49615F]">{row.anon_execute ? "anon " : ""}{row.authenticated_execute ? "authenticated" : "service-role only"}</td><td className="px-4 py-3">{row.should_be_public ? <Status tone="critical">REVIEW</Status> : <Status tone="healthy">no</Status>}</td></tr>)}</tbody></table></div></Card>
        </Section>

        <Section title="Queue and worker health" icon={Activity} refreshed={data.generated_at} onRefresh={() => load(true)}>
          <div className="grid gap-3 sm:grid-cols-2"><Metric label="Reprocessing queued" value={number(queues.queued)} note="extraction_reprocessing_jobs" tone={Number(queues.queued) ? "warning" : "normal"} /><Metric label="No source / failed" value={number(Number(queues.no_source || 0) + Number(queues.failed || 0))} note="terminal or failed reprocessing jobs" tone={Number(queues.no_source || 0) + Number(queues.failed || 0) ? "critical" : "normal"} /><Metric label="Dead-lettered" value={number(attempts.dead_lettered)} note="extraction_attempt_log" tone={Number(attempts.dead_lettered) ? "warning" : "normal"} /><Metric label="Boundary review" value={number(queues.tenant_boundary_pending)} note="pending review queue" tone={Number(queues.tenant_boundary_pending) ? "warning" : "normal"} /></div>
          <Card className="border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-4"><div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.12em] text-[#49615F]"><Zap className="h-3.5 w-3.5 text-[#287D82]" />Worker heartbeats</div>{heartbeats.length ? <div className="space-y-2">{heartbeats.map((row) => <div key={String(row.worker_name)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[rgba(22,37,43,.1)] bg-white px-3 py-2 text-xs"><span className="font-medium text-[#16252B]">{String(row.worker_name)}</span><span className="text-[#49615F]">{String(row.service_name || "service")}</span><Status tone={row.status === "running" ? "healthy" : "warning"}>{String(row.status || "unknown")}</Status><span className="font-mono text-[10px] text-[#49615F]">{when(String(row.heartbeat_at || ""))}</span></div>)}</div> : <p className="text-xs text-[#49615F]">No heartbeat rows are currently recorded.</p>}</Card>
        </Section>
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        <Section title="Data quality signals" icon={AlertTriangle} refreshed={data.generated_at} onRefresh={() => load(true)}>
          <div className="grid gap-3 sm:grid-cols-2"><Metric label="Needs review" value={number(reviewRows)} note="typed listing/requirement rows" tone={reviewRows ? "warning" : "normal"} /><Metric label="Duplicate flagged" value={number(flaggedRows)} note="duplicate_status = flagged" tone={flaggedRows ? "warning" : "normal"} /><Metric label="Duplicate key groups" value={number(duplicateKeys)} note="tenant_id + raw_message_id" tone={duplicateKeys ? "critical" : "normal"} /><Metric label="Missing sources" value={number(sourceViolations)} note="must remain zero" tone={sourceViolations ? "critical" : "normal"} /></div>
          <Card className="overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9]"><div className="max-h-[330px] overflow-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="sticky top-0 bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr><th className="px-4 py-3">Typed table</th><th className="px-4 py-3">Review</th><th className="px-4 py-3">Flagged</th><th className="px-4 py-3">Missing source</th><th className="px-4 py-3">Dup keys</th></tr></thead><tbody>{quality.filter((row) => row.needs_review !== undefined).map((row) => <tr key={row.table_name} className="border-t border-[rgba(22,37,43,.08)]"><td className="px-4 py-3 font-mono text-[#16252B]">{row.table_name}</td><td className="px-4 py-3">{number(row.needs_review)}</td><td className="px-4 py-3">{number(row.duplicate_flagged)}</td><td className={row.missing_source_rows ? "px-4 py-3 font-semibold text-[#A9362E]" : "px-4 py-3 text-[#2F6B3A]"}>{number(row.missing_source_rows)}</td><td className={row.duplicate_key_groups ? "px-4 py-3 font-semibold text-[#8A5A00]" : "px-4 py-3 text-[#2F6B3A]"}>{number(row.duplicate_key_groups)}</td></tr>)}</tbody></table></div></Card>
        </Section>

        <Section title="Indexes and performance" icon={Timer} refreshed={data.generated_at} onRefresh={() => load(true)}>
          <div className="grid gap-3 sm:grid-cols-3"><Metric label="Missing FK indexes" value={number(data.indexes.missing_fk_indexes.length)} note="catalog-derived" tone={data.indexes.missing_fk_indexes.length ? "warning" : "normal"} /><Metric label="Unused indexes" value={number(data.indexes.unused.length)} note="idx_scan = 0" tone={data.indexes.unused.length ? "warning" : "normal"} /><Metric label="Duplicate indexes" value={number(data.indexes.duplicate.length)} note="same table + definition" tone={data.indexes.duplicate.length ? "warning" : "normal"} /></div>
          <Card className="border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-4 text-xs text-[#49615F]"><div className="flex items-start gap-3"><Activity className="mt-0.5 h-4 w-4 shrink-0 text-[#287D82]" /><div><p className="font-semibold text-[#16252B]">Catalog-backed advisor signal</p><p className="mt-1 leading-5">Missing-FK, unused, and duplicate-index signals are recomputed with this live snapshot. Supabase Advisor API output is not cached or represented as fresher data here; this panel is the database-native baseline to review before an advisor run.</p></div></div></Card>
          <div className="rounded-lg border border-[rgba(22,37,43,.1)] bg-white p-3 text-[11px] text-[#49615F]">{data.indexes.missing_fk_indexes.slice(0, 8).map((row, index) => <div key={index} className="flex justify-between gap-3 border-b border-[rgba(22,37,43,.07)] py-2 last:border-0"><span className="font-mono text-[#16252B]">{String(row.table_name)}.{String(row.column_name)}</span><span>{String(row.constraint_name)}</span></div>)}{!data.indexes.missing_fk_indexes.length && "No missing foreign-key indexes detected."}</div>
        </Section>
      </div>
    </div>
  </main>;
}
