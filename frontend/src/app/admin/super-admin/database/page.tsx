"use client";

export const dynamic = "force-dynamic";

import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, AlertTriangle, ArrowLeft, Bot, Database, ExternalLink, Eye, RefreshCw, Search, ShieldAlert, SlidersHorizontal, Timer, Zap } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AssistantUiOpsChat } from "@/components/admin/AssistantUiOpsChat";

type TableRow = { name: string; group_name: string; row_count: number; rls_enabled: boolean; policy_count: number; last_analyzed_at: string | null; approximate_size_bytes: number; is_legacy: boolean };
type FunctionRow = { name: string; arguments: string; security_definer: boolean; anon_execute: boolean; authenticated_execute: boolean; service_role_execute: boolean; should_be_public: boolean };
type QualityRow = { table_name: string; missing_source_rows?: number; duplicate_key_groups?: number; needs_review?: number; duplicate_flagged?: number; locality_resolved_rows?: number; locality_total_rows?: number };
type Snapshot = { generated_at: string; tables: TableRow[]; rls_zero_policy: { name: string; row_count: number }[]; functions: FunctionRow[]; queues: Record<string, unknown>; quality: QualityRow[]; locality_resolution: { resolved_rows: number; total_rows: number; rate_pct: number | null; listing_label_rows?: number; listing_canonical_rows?: number; listing_total_rows?: number; listing_label_rate_pct?: number | null; listing_canonical_rate_pct?: number | null }; indexes: { unused: Record<string, unknown>[]; duplicate: Record<string, unknown>[]; missing_fk_indexes: Record<string, unknown>[] } };
type EvidenceResponse = { kind: string; table_name?: string; rows: Record<string, unknown>[] };

const GROUPS = ["all", "extraction / typed listings", "WhatsApp ingestion", "broker / CRM", "embeddings / semantic", "jobs / queues", "auth / org", "legacy", "other"];

function number(value: unknown) { return Number(value || 0).toLocaleString("en-IN"); }
function bytes(value: unknown) { const n = Number(value || 0); if (n < 1024) return `${n} B`; if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`; if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`; return `${(n / 1024 ** 3).toFixed(1)} GB`; }
function when(value: string | null | undefined) { return value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not tracked"; }
function groupLabel(value: string) {
  const labels: Record<string, string> = {
    "extraction / typed listings": "Listings and requirements",
    "WhatsApp ingestion": "WhatsApp messages",
    "broker / CRM": "Brokers and clients",
    "embeddings / semantic": "Search and matching",
    "jobs / queues": "Background jobs",
    "auth / org": "Accounts and teams",
    legacy: "Older records",
    other: "Supporting data",
  };
  return labels[value] || value;
}

function Status({ tone, children }: { tone: "healthy" | "warning" | "critical"; children: ReactNode }) {
  const classes = tone === "healthy" ? "border-[#2f6b3a]/30 bg-[#2f6b3a]/10 text-[#2f6b3a]" : tone === "warning" ? "border-[#8a5a00]/35 bg-[#8a5a00]/10 text-[#8a5a00]" : "border-[#a9362e]/30 bg-[#a9362e]/10 text-[#a9362e]";
  return <Badge variant="outline" className={classes}>{children}</Badge>;
}

function Section({ id, title, icon: Icon, refreshed, onRefresh, children }: { id?: string; title: string; icon: typeof Database; refreshed: string | null; onRefresh: () => void; children: ReactNode }) {
  return <section id={id} className="scroll-mt-6 space-y-3">
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

function EvidencePanel({ evidence, loading, error, onClose, onRetry }: { evidence: EvidenceResponse | null; loading: boolean; error: string | null; onClose: () => void; onRetry: () => void }) {
  if (!evidence && !loading && !error) return null;
  const rows = evidence?.rows || [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return <Card className="border-[#287D82]/30 bg-white shadow-[0_8px_22px_rgba(22,37,43,.08)]">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[rgba(22,37,43,.1)] px-4 py-3"><div><div className="flex items-center gap-2 text-sm font-semibold text-[#16252B]"><Eye className="h-4 w-4 text-[#287D82]" />Evidence: {evidence?.table_name || evidence?.kind || "loading"}</div><p className="mt-1 text-[11px] text-[#49615F]">Bounded, read-only records behind this live signal.</p></div><button type="button" onClick={onClose} className="text-xs text-[#49615F] hover:text-[#16252B]">Close</button></div>
    {loading && <p className="p-4 text-xs text-[#49615F]">Loading evidence…</p>}
    {error && <div className="flex flex-wrap items-center justify-between gap-3 p-4"><p className="text-xs text-[#A9362E]">{error}</p><Button variant="outline" size="sm" onClick={onRetry}>Retry evidence</Button></div>}
    {!loading && !error && !rows.length && <p className="p-4 text-xs text-[#49615F]">No matching records in the current bounded view.</p>}
    {!loading && !error && rows.length > 0 && <div className="max-h-[360px] overflow-auto"><table className="w-full min-w-[720px] text-left text-xs"><thead className="sticky top-0 bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr>{columns.map((column) => <th key={column} className="px-4 py-3">{column.replaceAll("_", " ")}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)} className="border-t border-[rgba(22,37,43,.08)] align-top">{columns.map((column) => <td key={column} className="max-w-[320px] px-4 py-3 font-mono text-[11px] text-[#16252B]">{row[column] == null ? "—" : String(row[column])}</td>)}</tr>)}</tbody></table></div>}
  </Card>;
}

function AdvisorOverview({ snapshot }: { snapshot: Snapshot }) {
  const listingSourceViolations = snapshot.quality.filter((row) => row.table_name.endsWith("_listings")).reduce((sum, row) => sum + Number(row.missing_source_rows || 0), 0);
  const requirementSourceGaps = snapshot.quality.filter((row) => row.table_name.endsWith("_requirements")).reduce((sum, row) => sum + Number(row.missing_source_rows || 0), 0);
  const reviewRows = snapshot.quality.reduce((sum, row) => sum + Number(row.needs_review || 0), 0);
  const findings = [
    { tone: "critical" as const, title: "Review RLS gaps", detail: `${number(snapshot.rls_zero_policy.length)} tables have RLS enabled with no policies. Confirm each is intentionally service-role-only.`, href: "#security" },
    { tone: listingSourceViolations ? "critical" as const : "healthy" as const, title: listingSourceViolations ? "Repair listing source links" : "Listing source links are intact", detail: listingSourceViolations ? `${number(listingSourceViolations)} listing rows reference a missing raw message.` : "0 listing rows reference a missing raw message in the current live check.", href: "#quality" },
    { tone: "warning" as const, title: "Improve listing locality coverage", detail: `${snapshot.locality_resolution.listing_label_rate_pct ?? 0}% of ${number(snapshot.locality_resolution.listing_total_rows ?? 0)} listings have a locality label; canonical resolution is ${snapshot.locality_resolution.listing_canonical_rate_pct ?? 0}%.`, href: "#quality" },
    { tone: requirementSourceGaps ? "warning" as const : "healthy" as const, title: requirementSourceGaps ? "Review requirement evidence gaps" : "Requirement evidence is intact", detail: requirementSourceGaps ? `${number(requirementSourceGaps)} requirement rows lack a matching raw message.` : "No requirement source gaps found.", href: "#quality" },
    { tone: reviewRows ? "warning" as const : "healthy" as const, title: reviewRows ? "Clear review queue" : "Review queue is clear", detail: reviewRows ? `${number(reviewRows)} typed rows are marked needs_review.` : "No typed rows are currently marked needs_review.", href: "#quality" },
  ];
  return <Card className="border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-5 shadow-[0_8px_22px_rgba(22,37,43,.05)]"><div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#287D82]">PropAI Advisor</p><h2 className="mt-1 text-xl font-semibold tracking-[-.03em] text-[#16252B]">What needs attention</h2><p className="mt-2 max-w-xl text-xs leading-5 text-[#49615F]">Database-native checks ranked by operational risk. Select a finding to inspect its evidence, or ask the agent for a safe repair plan.</p></div><Status tone="warning">{findings.filter((finding) => finding.tone !== "healthy").length} findings</Status></div><div className="mt-5 divide-y divide-[rgba(22,37,43,.1)] border-y border-[rgba(22,37,43,.1)]">{findings.map((finding) => <Link key={finding.title} href={finding.href} className="group flex items-start gap-3 py-3 transition-colors hover:bg-white/60"><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${finding.tone === "critical" ? "bg-[#A9362E]" : finding.tone === "warning" ? "bg-[#D08A00]" : "bg-[#2F6B3A]"}`} /><span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-[#16252B] group-hover:text-[#287D82]">{finding.title}</span><span className="mt-1 block text-xs leading-5 text-[#49615F]">{finding.detail}</span></span><ExternalLink className="mt-1 h-3.5 w-3.5 shrink-0 text-[#7B9290]" /></Link>)}</div><div className="mt-4 flex flex-wrap gap-2"><Link href="#security" className="rounded-md border border-[rgba(22,37,43,.16)] px-3 py-1.5 text-[11px] font-medium text-[#49615F] hover:border-[#287D82] hover:text-[#287D82]">Inspect security</Link><Link href="#quality" className="rounded-md border border-[rgba(22,37,43,.16)] px-3 py-1.5 text-[11px] font-medium text-[#49615F] hover:border-[#287D82] hover:text-[#287D82]">Inspect quality</Link><Link href="/admin/ops" className="inline-flex items-center gap-1 rounded-md bg-[#16252B] px-3 py-1.5 text-[11px] font-medium text-[#DDE8E5] hover:bg-[#287D82]">Ask AI Advisor <Bot className="h-3.5 w-3.5" /></Link></div></Card>;
}

function OperationsAgentCard({ snapshot }: { snapshot: Snapshot }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const [statusText, setStatusText] = useState("Checking agent…");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchJSON<{ reachable?: boolean }>("/admin/ops/status"),
      fetchJSON<{ id: string }>("/admin/ops/sessions", { method: "POST", body: JSON.stringify({ title: "Database operations" }) }),
    ]).then(([status, session]) => {
      if (cancelled) return;
      setAgentReady(status.reachable === true);
      setStatusText(status.reachable === true ? "Connected · approval-gated" : "Unavailable · retry from Operations Agent");
      setSessionId(session.id);
    }).catch(() => {
      if (!cancelled) setStatusText("Unavailable · check agent status");
    });
    return () => { cancelled = true; };
  }, []);

  const context = `Current Supabase observability snapshot: ${snapshot.tables.length} public tables; ${snapshot.rls_zero_policy.length} RLS gaps; ${snapshot.locality_resolution.rate_pct ?? 0}% locality resolution (${snapshot.locality_resolution.resolved_rows}/${snapshot.locality_resolution.total_rows}); ${snapshot.quality.reduce((sum, row) => sum + Number(row.missing_source_rows || 0), 0)} missing-source rows; ${snapshot.quality.reduce((sum, row) => sum + Number(row.needs_review || 0), 0)} rows needing review. Diagnose these signals using live evidence and propose the safest next action.`;

  return <Card className="flex min-h-[420px] flex-col overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9] shadow-[0_8px_22px_rgba(22,37,43,.05)]">
    <div className="flex items-start justify-between gap-3 border-b border-[rgba(22,37,43,.1)] p-4"><div className="flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#16252B] text-[#8BCB68]"><Bot className="h-4 w-4" /></span><div><h2 className="text-sm font-semibold text-[#16252B]">AI Advisor</h2><p className="mt-1 text-[11px] text-[#49615F]">{statusText}</p></div></div><Link href={sessionId ? `/admin/ops?session_id=${encodeURIComponent(sessionId)}` : "/admin/ops"} className="inline-flex items-center gap-1 text-[11px] text-[#287D82] hover:text-[#16252B]">Full agent <ExternalLink className="h-3 w-3" /></Link></div>
    <div className="min-h-0 flex-1"><AssistantUiOpsChat sessionId={sessionId} agentReady={agentReady} context={context} onError={setStatusText} /></div>
    <div className="border-t border-[rgba(22,37,43,.1)] px-4 py-2 text-[10px] text-[#49615F]">This advisor can explain the checks and prepare a safe plan. Any production change still needs approval.</div>
  </Card>;
}

function ObservabilityLoading() {
  const checks = [
    ["Schema catalog", "Tables, row estimates, and public views"],
    ["Security checks", "RLS policies and function permissions"],
    ["Pipeline health", "Queues, failures, and worker heartbeats"],
    ["Data quality", "Source links, locality coverage, and index risk"],
  ];
  return <main aria-busy="true" aria-label="Loading database observability" className="min-h-screen bg-[#DDE8E5] px-4 py-6 text-[#16252B] sm:px-8 lg:px-10">
    <div className="mx-auto max-w-[1500px] space-y-7">
      <header className="flex flex-wrap items-start justify-between gap-5 border-b border-[rgba(22,37,43,.14)] pb-6">
        <div>
          <div className="h-3 w-28 animate-pulse rounded bg-[#287D82]/20" />
          <div className="mt-3 h-8 w-64 animate-pulse rounded bg-[#16252B]/15" />
          <p className="mt-3 text-sm text-[#49615F]">Preparing a fresh, read-only view of the PropAI database.</p>
        </div>
        <div className="h-9 w-28 animate-pulse rounded-md bg-[#16252B]/10" />
      </header>
      <section className="rounded-2xl border border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-5 shadow-[0_8px_22px_rgba(22,37,43,.05)]">
        <div className="flex items-start gap-3">
          <span className="mt-1 h-2.5 w-2.5 animate-pulse rounded-full bg-[#287D82]" />
          <div><h1 className="text-base font-semibold">Checking live database health</h1><p className="mt-1 text-xs text-[#49615F]">These checks are read-only. The page will fill in as the snapshot is returned.</p></div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {checks.map(([title, detail]) => <div key={title} className="rounded-xl border border-[rgba(22,37,43,.1)] bg-white/70 p-4">
            <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold text-[#16252B]">{title}</span><span className="h-2 w-2 animate-pulse rounded-full bg-[#8BCB68]" /></div>
            <p className="mt-1 text-[11px] text-[#49615F]">{detail}</p>
            <div className="mt-3 h-2 w-full animate-pulse rounded-full bg-[#DDE8E5]" />
          </div>)}
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 animate-pulse rounded-xl border border-[rgba(22,37,43,.1)] bg-[#F6FBF9]" />)}</div>
      <div className="grid gap-5 xl:grid-cols-2"><div className="h-80 animate-pulse rounded-xl border border-[rgba(22,37,43,.1)] bg-[#F6FBF9]" /><div className="h-80 animate-pulse rounded-xl border border-[rgba(22,37,43,.1)] bg-[#F6FBF9]" /></div>
    </div>
  </main>;
}

export default function SupabaseObservabilityPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [sort, setSort] = useState<"name" | "rows" | "size">("name");
  const [evidence, setEvidence] = useState<EvidenceResponse | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true); setError(null);
    try { setData(await fetchJSON<Snapshot>("/admin/supabase-observability")); }
    catch (e) {
      const message = e instanceof Error ? e.message : "";
      setError(/\b50[23]\b|observability snapshot/i.test(message)
        ? "The live database check did not complete. Try again in a few seconds."
        : message || "Live database checks could not be loaded. Try again in a few seconds.");
    }
    finally { quiet ? setRefreshing(false) : setLoading(false); }
  }, []);
  const inspect = useCallback(async (kind: string, tableName?: string) => {
    setEvidenceLoading(true); setEvidenceError(null); setEvidence({ kind, table_name: tableName, rows: [] });
    try {
      const suffix = tableName ? `&table_name=${encodeURIComponent(tableName)}` : "";
      setEvidence(await fetchJSON<EvidenceResponse>(`/admin/supabase-observability/evidence?kind=${encodeURIComponent(kind)}${suffix}`));
    } catch (e) { setEvidenceError(e instanceof Error ? e.message : "Evidence could not be loaded"); }
    finally { setEvidenceLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const tables = useMemo(() => (data?.tables || []).filter((row) => (!query || row.name.toLowerCase().includes(query.toLowerCase())) && (group === "all" || row.group_name === group)).sort((a, b) => sort === "rows" ? b.row_count - a.row_count : sort === "size" ? b.approximate_size_bytes - a.approximate_size_bytes : a.name.localeCompare(b.name)), [data, group, query, sort]);
  const quality = data?.quality || [];
  const listingSourceViolations = quality.filter((row) => row.table_name.endsWith("_listings")).reduce((sum, row) => sum + Number(row.missing_source_rows || 0), 0);
  const requirementSourceGaps = quality.filter((row) => row.table_name.endsWith("_requirements")).reduce((sum, row) => sum + Number(row.missing_source_rows || 0), 0);
  const duplicateKeys = quality.reduce((sum, row) => sum + Number(row.duplicate_key_groups || 0), 0);
  const reviewRows = quality.reduce((sum, row) => sum + Number(row.needs_review || 0), 0);
  const flaggedRows = quality.reduce((sum, row) => sum + Number(row.duplicate_flagged || 0), 0);
  const queues = data?.queues || {};
  const attempts = (queues.attempt_log || {}) as Record<string, number>;
  const heartbeats = Array.isArray(queues.heartbeats) ? queues.heartbeats as Record<string, unknown>[] : [];
  const staleHeartbeats = heartbeats.filter((row) => row.status !== "running").length;

  if (loading) return <ObservabilityLoading />;
  if (error || !data) return <main className="min-h-screen bg-[#DDE8E5] p-8"><Card className="mx-auto max-w-2xl border-[#A9362E]/30 bg-[#FFF7F5] p-6 text-[#7D2B25]"><h1 className="font-semibold">Observability snapshot unavailable</h1><p className="mt-2 text-sm">{error || "No snapshot returned"}</p><Button className="mt-4" onClick={() => load()}>Try again</Button></Card></main>;

  return <main className="min-h-[calc(100dvh-44px)] bg-[#DDE8E5] px-4 py-6 text-[#16252B] sm:px-8 lg:px-10">
    <div className="mx-auto max-w-[1500px] space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-5 border-b border-[rgba(22,37,43,.14)] pb-6">
        <div><Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-xs text-[#49615F] hover:text-[#16252B]"><ArrowLeft className="h-3.5 w-3.5" />Super Admin</Link><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#16252B] text-[#8BCB68]"><Database className="h-5 w-5" /></div><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#287D82]">Database health</p><h1 className="text-2xl font-semibold tracking-[-.035em]">How PropAI’s data is doing</h1></div></div><p className="mt-3 max-w-2xl text-sm text-[#49615F]">A read-only check of the data behind listings, WhatsApp messages, search, and background jobs. Use the numbers below to see what is healthy and what needs attention.</p></div>
        <div className="flex items-center gap-3"><div className="text-right text-[11px] text-[#49615F]"><div className="flex items-center justify-end gap-1.5"><span className="h-2 w-2 rounded-full bg-[#2F6B3A]" />Live snapshot</div><div className="mt-1">{when(data.generated_at)}</div></div><Button onClick={() => load(true)} disabled={refreshing} className="bg-[#16252B] text-[#DDE8E5] hover:bg-[#287D82]"><RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />Refresh all</Button></div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[1.05fr_.95fr]"><AdvisorOverview snapshot={data} /><OperationsAgentCard snapshot={data} /></div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Metric label="Data areas" value={number(data.tables.length)} note="Parts of the database currently in use" />
        <Metric label="Access checks needing review" value={number(data.rls_zero_policy.length)} note="Tables without a defined access rule" tone={data.rls_zero_policy.length ? "critical" : "normal"} />
        <Metric label="Listings with a location" value={`${data.locality_resolution.listing_label_rate_pct ?? 0}%`} note={`${number(data.locality_resolution.listing_label_rows)} of ${number(data.locality_resolution.listing_total_rows)} listings`} tone={(data.locality_resolution.listing_label_rate_pct ?? 0) < 80 ? "warning" : "normal"} />
        <Metric label="Listings missing their source" value={number(listingSourceViolations)} note="Every listing should link to its WhatsApp message" tone={listingSourceViolations ? "critical" : "normal"} />
        <Metric label="Buyer requests needing evidence" value={number(requirementSourceGaps)} note="Requests that need their original message checked" tone={requirementSourceGaps ? "warning" : "normal"} />
        <Metric label="Background jobs needing attention" value={number(staleHeartbeats)} note={`${number(heartbeats.length)} workers checked recently`} tone={staleHeartbeats ? "warning" : "normal"} />
      </div>

      <Card className="border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-4 shadow-[0_8px_22px_rgba(22,37,43,.05)]"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-semibold text-[#16252B]">Look behind the numbers</h2><p className="mt-1 text-xs text-[#49615F]">Open a small, read-only sample to understand what needs attention before making a change.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => inspect("queue")}><Eye className="h-3.5 w-3.5" />Jobs waiting</Button><Button variant="outline" size="sm" onClick={() => inspect("failed")}><Eye className="h-3.5 w-3.5" />Failed jobs</Button><Button variant="outline" size="sm" onClick={() => inspect("rls")}><Eye className="h-3.5 w-3.5" />Access checks</Button></div></div><div className="mt-3 flex flex-wrap items-center gap-2"><select defaultValue="" onChange={(e) => { if (e.target.value) { const [kind, table] = e.target.value.split("|"); inspect(kind, table); } }} className="h-8 rounded-md border border-[rgba(22,37,43,.16)] bg-white px-2 text-xs text-[#16252B]"><option value="">Choose listings or buyer requests to inspect…</option>{tables.filter((row) => row.name.endsWith("_listings") || row.name.endsWith("_requirements")).map((row) => <><option key={`review-${row.name}`} value={`review|${row.name}`}>Needs checking · {row.name}</option><option key={`duplicates-${row.name}`} value={`duplicates|${row.name}`}>Possible duplicates · {row.name}</option></>)}</select></div></Card>
      <EvidencePanel evidence={evidence} loading={evidenceLoading} error={evidenceError} onClose={() => { setEvidence(null); setEvidenceError(null); }} onRetry={() => { if (evidence?.kind) void inspect(evidence.kind, evidence.table_name); }} />

      <Section title="What data PropAI stores" icon={Database} refreshed={data.generated_at} onRefresh={() => load(true)}>
        <Card className="overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9] shadow-[0_8px_22px_rgba(22,37,43,.05)]">
          <div className="flex flex-wrap gap-2 border-b border-[rgba(22,37,43,.1)] p-3"><label className="relative min-w-[230px] flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-[#49615F]" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a data area" className="h-9 w-full rounded-md border border-[rgba(22,37,43,.16)] bg-white pl-9 pr-3 text-sm text-[#16252B] outline-none focus:border-[#287D82] focus:ring-2 focus:ring-[#287D82]/25" /></label><select value={group} onChange={(e) => setGroup(e.target.value)} className="h-9 rounded-md border border-[rgba(22,37,43,.16)] bg-white px-3 text-xs text-[#16252B] outline-none focus:border-[#287D82]">{GROUPS.map((item) => <option key={item} value={item}>{item === "all" ? "All data areas" : groupLabel(item)}</option>)}</select><select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="h-9 rounded-md border border-[rgba(22,37,43,.16)] bg-white px-3 text-xs text-[#16252B] outline-none focus:border-[#287D82]"><option value="name">Sort: name</option><option value="rows">Sort: record count</option><option value="size">Sort: storage used</option></select><div className="flex items-center gap-1 px-2 text-[11px] text-[#49615F]"><SlidersHorizontal className="h-3.5 w-3.5" />{number(tables.length)} shown</div></div>
          <div className="hidden max-h-[560px] overflow-auto sm:block"><table className="w-full min-w-[850px] text-left text-xs"><thead className="sticky top-0 bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr><th className="px-4 py-3">Data area</th><th className="px-4 py-3">Records</th><th className="px-4 py-3">Access protection</th><th className="px-4 py-3">Access rules</th><th className="px-4 py-3">Storage used</th><th className="px-4 py-3">Last checked</th></tr></thead><tbody>{tables.map((row) => <tr key={row.name} className="border-t border-[rgba(22,37,43,.08)] hover:bg-white"><td className="px-4 py-3"><div className="flex items-center gap-2 font-mono text-[12px] text-[#16252B]">{row.name}{row.is_legacy && <Status tone="warning">OLDER DATA</Status>}</div><div className="mt-1 text-[10px] text-[#49615F]">{groupLabel(row.group_name)}</div></td><td className="px-4 py-3 font-mono text-[#16252B]">{number(row.row_count)}</td><td className="px-4 py-3">{row.rls_enabled ? <Status tone={row.policy_count ? "healthy" : "critical"}>{row.policy_count ? "Protected" : "Needs review"}</Status> : <Status tone="warning">Not protected</Status>}</td><td className="px-4 py-3 font-mono text-[#16252B]">{number(row.policy_count)}</td><td className="px-4 py-3 text-[#49615F]">{bytes(row.approximate_size_bytes)}</td><td className="px-4 py-3 text-[#49615F]">{when(row.last_analyzed_at)}</td></tr>)}</tbody></table></div>
          <div className="divide-y divide-[rgba(22,37,43,.1)] sm:hidden">{tables.map((row) => <article key={row.name} className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2 font-mono text-[12px] font-semibold text-[#16252B]">{row.name}{row.is_legacy && <Status tone="warning">OLDER DATA</Status>}</div><p className="mt-1 text-[10px] text-[#49615F]">{groupLabel(row.group_name)}</p></div>{row.rls_enabled ? <Status tone={row.policy_count ? "healthy" : "critical"}>{row.policy_count ? "Protected" : "Needs review"}</Status> : <Status tone="warning">Not protected</Status>}</div><dl className="mt-3 grid grid-cols-2 gap-3 text-[11px]"><div><dt className="text-[#49615F]">Records</dt><dd className="mt-0.5 font-mono font-semibold text-[#16252B]">{number(row.row_count)}</dd></div><div><dt className="text-[#49615F]">Access rules</dt><dd className="mt-0.5 font-mono font-semibold text-[#16252B]">{number(row.policy_count)}</dd></div><div><dt className="text-[#49615F]">Storage used</dt><dd className="mt-0.5 text-[#16252B]">{bytes(row.approximate_size_bytes)}</dd></div><div><dt className="text-[#49615F]">Last checked</dt><dd className="mt-0.5 text-[#16252B]">{when(row.last_analyzed_at)}</dd></div></dl></article>)}</div>
        </Card>
      </Section>

      <div className="grid gap-8 xl:grid-cols-2">
        <Section id="security" title="Who can access the data" icon={ShieldAlert} refreshed={data.generated_at} onRefresh={() => load(true)}>
          {data.rls_zero_policy.length > 0 && <Card className="border-[#A9362E]/25 bg-[#FFF7F5] p-4"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#A9362E]" /><div><div className="text-sm font-semibold text-[#7D2B25]">{number(data.rls_zero_policy.length)} RLS gaps require review</div><p className="mt-1 text-xs text-[#7D2B25]">RLS is enabled but no policy is attached; service-role workers may be intentional, but these must be explicitly reviewed.</p><div className="mt-3 flex flex-wrap gap-1.5">{data.rls_zero_policy.slice(0, 30).map((row) => <Badge key={row.name} variant="outline" className="border-[#A9362E]/25 text-[#7D2B25]">{row.name} · {number(row.row_count)}</Badge>)}</div></div></div></Card>}
          <Card className="overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9]"><div className="border-b border-[rgba(22,37,43,.1)] px-4 py-3 text-[11px] text-[#49615F]">Functions with elevated access · these are checked to ensure they are not accidentally open to everyone</div><div className="max-h-[360px] overflow-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr><th className="px-4 py-3">Database action</th><th className="px-4 py-3">Access level</th><th className="px-4 py-3">Who can run it</th><th className="px-4 py-3">Needs public access?</th></tr></thead><tbody>{data.functions.filter((row) => row.security_definer).map((row) => <tr key={`${row.name}-${row.arguments}`} className="border-t border-[rgba(22,37,43,.08)]"><td className="px-4 py-3 font-mono text-[#16252B]">{row.name}<span className="ml-1 text-[10px] text-[#49615F]">({row.arguments})</span></td><td className="px-4 py-3"><Status tone="warning">Elevated</Status></td><td className="px-4 py-3 text-[#49615F]">{row.anon_execute ? "Anyone " : ""}{row.authenticated_execute ? "signed-in users" : "PropAI services only"}</td><td className="px-4 py-3">{row.should_be_public ? <Status tone="critical">Review</Status> : <Status tone="healthy">No</Status>}</td></tr>)}</tbody></table></div></Card>
        </Section>

        <Section title="Queue and worker health" icon={Activity} refreshed={data.generated_at} onRefresh={() => load(true)}>
          <div className="grid gap-3 sm:grid-cols-2"><Metric label="Jobs waiting to run" value={number(queues.queued)} note="Listings waiting for processing" tone={Number(queues.queued) ? "warning" : "normal"} /><Metric label="Jobs that could not finish" value={number(Number(queues.no_source || 0) + Number(queues.failed || 0))} note="Jobs missing information or ending in error" tone={Number(queues.no_source || 0) + Number(queues.failed || 0) ? "critical" : "normal"} /><Metric label="Jobs sent for later review" value={number(attempts.dead_lettered)} note="Processing attempts that need attention" tone={Number(attempts.dead_lettered) ? "warning" : "normal"} /><Metric label="Account-boundary checks" value={number(queues.tenant_boundary_pending)} note="Records waiting for workspace review" tone={Number(queues.tenant_boundary_pending) ? "warning" : "normal"} /></div>
          <Card className="border-[rgba(22,37,43,.14)] bg-[#F6FBF9] p-4"><div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[.12em] text-[#49615F]"><Zap className="h-3.5 w-3.5 text-[#287D82]" />Worker heartbeats</div>{heartbeats.length ? <div className="space-y-2">{heartbeats.map((row) => <div key={String(row.worker_name)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[rgba(22,37,43,.1)] bg-white px-3 py-2 text-xs"><span className="font-medium text-[#16252B]">{String(row.worker_name)}</span><span className="text-[#49615F]">{String(row.service_name || "service")}</span><Status tone={row.status === "running" ? "healthy" : "warning"}>{String(row.status || "unknown")}</Status><span className="font-mono text-[10px] text-[#49615F]">{when(String(row.heartbeat_at || ""))}</span></div>)}</div> : <p className="text-xs text-[#49615F]">No heartbeat rows are currently recorded.</p>}</Card>
        </Section>
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        <Section id="quality" title="Data quality signals" icon={AlertTriangle} refreshed={data.generated_at} onRefresh={() => load(true)}>
          <div className="grid gap-3 sm:grid-cols-2"><Metric label="Records waiting for review" value={number(reviewRows)} note="Listings or buyer requests to check" tone={reviewRows ? "warning" : "normal"} /><Metric label="Possible duplicates flagged" value={number(flaggedRows)} note="Records marked as possible duplicates" tone={flaggedRows ? "warning" : "normal"} /><Metric label="Repeated message groups" value={number(duplicateKeys)} note="The same WhatsApp message recorded more than once" tone={duplicateKeys ? "critical" : "normal"} /><Metric label="Listings missing their source" value={number(listingSourceViolations)} note="Must remain zero" tone={listingSourceViolations ? "critical" : "normal"} /><Metric label="Buyer requests missing evidence" value={number(requirementSourceGaps)} note="Requests whose original message needs checking" tone={requirementSourceGaps ? "warning" : "normal"} /></div>
          <Card className="overflow-hidden border-[rgba(22,37,43,.14)] bg-[#F6FBF9]"><div className="max-h-[330px] overflow-auto"><table className="w-full min-w-[620px] text-left text-xs"><thead className="sticky top-0 bg-[#EAF3F0] text-[10px] uppercase tracking-[.12em] text-[#49615F]"><tr><th className="px-4 py-3">Data area</th><th className="px-4 py-3">Needs checking</th><th className="px-4 py-3">Possible duplicates</th><th className="px-4 py-3">Missing original message</th><th className="px-4 py-3">Repeated message groups</th></tr></thead><tbody>{quality.filter((row) => row.needs_review !== undefined).map((row) => <tr key={row.table_name} className="border-t border-[rgba(22,37,43,.08)]"><td className="px-4 py-3 font-mono text-[#16252B]">{row.table_name}</td><td className="px-4 py-3">{number(row.needs_review)}</td><td className="px-4 py-3">{number(row.duplicate_flagged)}</td><td className={row.missing_source_rows ? "px-4 py-3 font-semibold text-[#A9362E]" : "px-4 py-3 text-[#2F6B3A]"}>{number(row.missing_source_rows)}</td><td className={row.duplicate_key_groups ? "px-4 py-3 font-semibold text-[#8A5A00]" : "px-4 py-3 text-[#2F6B3A]"}>{number(row.duplicate_key_groups)}</td></tr>)}</tbody></table></div></Card>
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
