"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchJSON } from "@/lib/api";

type CountBlock = { searches_last_7_days: number; last_at: string | null };
type BrokerUsage = {
  tenant_id: string; org_name: string | null; setup_stage: string;
  last_real_search_at: string | null; searches_last_7_days: number;
  days_with_real_search_last_30_days: number;
  automation: CountBlock; assistant_unlabeled: CountBlock;
};
type UsageData = { generated_at: string; tenants: BrokerUsage[]; partial: boolean; notes: string[] };
const stages: Record<string, string> = { returning: "Returned on 2+ days", first_search: "First search recorded", whatsapp_connected: "WhatsApp linked", signed_up: "Signed up", setup_unknown: "Setup unavailable" };
function date(value: string | null) {
  return value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " IST" : "None recorded";
}

export default function BrokerUsagePage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const load = useCallback(async () => {
    setLoading(true); setError(null); setData(null);
    try { setData(await fetchJSON<UsageData>("/admin/usage/brokers")); }
    catch (cause) {
      const denied = cause instanceof Error && /^403\b/.test(cause.message);
      setError(denied ? "Super admin access is required. No counts are being shown." : "Usage could not be loaded. Retry in a moment. No counts are being shown.");
    }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const rows = data?.tenants.filter(t => `${t.org_name || ""} ${t.tenant_id}`.toLowerCase().includes(query.toLowerCase())) || [];
  return <main className="mx-auto max-w-6xl space-y-6 p-4 pb-28 sm:p-8 sm:pb-24">
    <Link href="/admin" className="text-sm text-[var(--text-secondary)] hover:underline">Back to Admin</Link>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs uppercase tracking-widest text-[var(--text-secondary)]">Product activity</p><h1 className="mt-2 text-3xl font-semibold text-[var(--text-primary)]">Broker usage</h1><p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">App searches, assistant searches and automated checks, kept separate for every workspace.</p></div>
      <button onClick={() => void load()} disabled={loading} className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50">Refresh</button>
    </header>
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-secondary)]">
      <p>Counts are per workspace, without user or API-key identity. Counts begin when tracking is enabled. No recorded usage does not mean a broker never used PropAI before that.</p>
      <p className="mt-2">One app event means a completed signed-in search request or search chat turn, not each nested tool call. Assistant/API initiators are unknown, so those searches are never treated as confirmed human activity. WhatsApp linked is a saved setup milestone, not live connection status. Days use India time. Returned means searches on at least two distinct days in the last 30 days.</p>
    </section>
    {loading && <p role="status" className="py-8 text-[var(--text-secondary)]">Loading broker usage...</p>}
    {error && <div role="alert" className="rounded-xl border border-red-400/40 p-4 text-sm">{error}<button className="ml-3 underline" onClick={() => void load()}>Retry</button></div>}
    {data && <>
      {data.partial && <p role="alert" className="rounded-lg border border-amber-500 p-4">Partial results: the safety limit was reached. Counts may be lower than actual usage.</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="w-full sm:w-80"><span className="mb-1 block text-xs text-[var(--text-secondary)]">Find a workspace</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Name or workspace ID" className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm" /></label>
        <p className="text-xs text-[var(--text-secondary)]">{rows.length} workspaces · Updated {date(data.generated_at)}</p>
      </div>
      {!rows.length && <p className="rounded-xl border border-[var(--border)] p-6 text-sm">{data.tenants.length ? "No matching workspaces." : "No workspaces were returned."}</p>}
      <div className="space-y-4">{rows.map(t => <article key={t.tenant_id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h2 className="break-words text-lg font-semibold">{t.org_name || "Unnamed workspace"}</h2><p className="mt-1 break-all text-xs text-[var(--text-secondary)]">{t.tenant_id}</p></div><span className="rounded-full border border-[var(--border)] px-3 py-1 text-xs">{stages[t.setup_stage] || "Stage unavailable"}</span></div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <section className="rounded-lg bg-[var(--surface-raised)] p-3"><h3 className="text-sm font-semibold">App searches</h3><p className="mt-2 text-2xl font-semibold">{t.searches_last_7_days}<span className="ml-2 text-xs font-normal">last 7 days</span></p><p className="mt-2 text-xs text-[var(--text-secondary)]">{t.days_with_real_search_last_30_days} active days / 30 days</p><p className="mt-1 text-xs text-[var(--text-secondary)]">Last: {date(t.last_real_search_at)}</p></section>
          <section className="rounded-lg border border-[var(--border)] p-3"><h3 className="text-sm font-semibold">Assistant / API</h3><p className="mt-2 text-2xl font-semibold">{t.assistant_unlabeled.searches_last_7_days}<span className="ml-2 text-xs font-normal">last 7 days</span></p><p className="mt-2 text-xs text-[var(--text-secondary)]">Initiator unknown, not added to app usage</p><p className="mt-1 text-xs text-[var(--text-secondary)]">Last in 30 days: {date(t.assistant_unlabeled.last_at)}</p></section>
          <section className="rounded-lg border border-[var(--border)] p-3"><h3 className="text-sm font-semibold">Automated checks</h3><p className="mt-2 text-2xl font-semibold">{t.automation.searches_last_7_days}<span className="ml-2 text-xs font-normal">last 7 days</span></p><p className="mt-2 text-xs text-[var(--text-secondary)]">Explicitly marked automation only</p><p className="mt-1 text-xs text-[var(--text-secondary)]">Last in 30 days: {date(t.automation.last_at)}</p></section>
        </div>
      </article>)}</div>
    </>}
  </main>;
}
