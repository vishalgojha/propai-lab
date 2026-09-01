"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Fingerprint, RefreshCw, ShieldCheck } from "lucide-react";
import { fetchJSON } from "@/lib/api";

type GateItem = {
  raw_id: number;
  decision: string;
  reason: string;
  fingerprint: string | null;
  received_at: string | null;
  processed_at: string | null;
  group_jid: string | null;
  sender: string;
  message_preview: string;
  repeat_of_raw_id: number | null;
  original: { raw_id: number; group_jid: string | null; received_at: string | null; fingerprint: string | null; message_preview: string } | null;
};

type GateEvidence = { total: number; returned: number; items: GateItem[] };

function date(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function short(value: string | null, size = 28): string {
  if (!value) return "—";
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

export function DedupeGatePage() {
  const [data, setData] = useState<GateEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await fetchJSON<GateEvidence>("/admin/dedupe-gate?limit=100", undefined, 30000));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dedupe evidence could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initial);
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-7xl min-w-0 p-4 sm:p-6 lg:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/admin" className="mt-1 text-zinc-400 hover:text-white"><ArrowLeft className="h-5 w-5" /></Link>
          <div>
            <p className="propai-kicker text-[10px] font-semibold">Gate observability</p>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold leading-tight tracking-[-0.025em] text-white sm:gap-3 sm:text-3xl sm:tracking-[-0.035em]"><ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400 sm:h-7 sm:w-7" /><span>Dedupe Gate Evidence</span></h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-500">Every exact repost is retained as raw evidence, linked to its first observation, and stopped before LLM extraction.</p>
          </div>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-2 rounded-lg border border-emerald-400/30 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-400/10"><RefreshCw className="h-4 w-4" />Refresh</button>
      </div>

      <section className="mb-6 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04] p-5 sm:p-6" aria-labelledby="dedupe-how-it-works">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg border border-cyan-300/20 bg-cyan-300/10 p-2"><Fingerprint className="h-4 w-4 text-cyan-200" /></div>
          <div className="min-w-0">
            <h2 id="dedupe-how-it-works" className="text-base font-semibold text-white">How the dedupe gate works</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-300">This is a pre-extraction safety check for exact broker reposts. It protects the database from duplicate typed rows while keeping every incoming WhatsApp observation available as evidence.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">1 · Identify</div>
            <p className="mt-2 text-sm leading-5 text-zinc-300">PropAI combines the resolved broker identity with a normalized copy of the message. Formatting-only changes such as case, line endings, and repeated spaces do not create a new fingerprint.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">2 · Claim</div>
            <p className="mt-2 text-sm leading-5 text-zinc-300">The first matching message atomically claims that fingerprint per tenant. This prevents two workers or two groups from both sending the same exact copy to extraction.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/15 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">3 · Preserve</div>
            <p className="mt-2 text-sm leading-5 text-zinc-300">A repost remains in <code className="text-cyan-100">raw_messages</code>, points to its first observation, refreshes freshness on the canonical typed row, and does not create another listing.</p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 text-xs leading-5 md:grid-cols-2">
          <div><span className="font-semibold text-emerald-200">What this improves:</span> fewer duplicate LLM calls, fewer duplicate cards, lower extraction cost, and safe concurrent worker behavior.</div>
          <div><span className="font-semibold text-amber-200">What it does not do:</span> it does not merge edited messages, different flats, different floors, or two brokers offering the same building. Those remain separate review or identity problems.</div>
        </div>
        <div className="mt-4 rounded-xl border border-amber-300/15 bg-amber-300/[0.05] px-4 py-3 text-xs leading-5 text-amber-100/90"><span className="font-semibold">Operator action:</span> normally none. Use the evidence below to verify the matched raw IDs. If this panel shows a 5xx or timeout, refresh first; that means the observability endpoint is unavailable, not that the gate has stopped protecting ingestion.</div>
      </section>

      {loading && <div className="rounded-xl border border-white/10 p-5 text-sm text-zinc-500">Loading gate evidence…</div>}
      {error && <div className="rounded-xl border border-rose-400/30 bg-rose-500/[0.08] p-4 text-sm text-rose-200">{error}</div>}
      {data && <>
        <section className="mb-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--accent-soft)] p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Gate-stopped reposts</div><div className="mt-1 text-2xl font-bold text-[color:var(--accent-forest)]">{data.total.toLocaleString("en-IN")}</div><div className="mt-1 text-xs text-[color:var(--text-muted)]">Raw observations preserved</div></div>
          <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Shown</div><div className="mt-1 text-2xl font-bold text-white">{data.returned}</div><div className="mt-1 text-xs text-zinc-500">Most recent evidence rows</div></div>
          <div className="rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--accent-soft)] p-4"><div className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--text-muted)]">Gate decision</div><div className="mt-1 text-lg font-bold text-[color:var(--accent-forest)]">Same author + fingerprint</div><div className="mt-1 text-xs text-[color:var(--text-muted)]">No LLM call or new typed row</div></div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/50">
          <div className="flex items-center gap-2 border-b border-white/10 p-5 font-semibold text-white"><Fingerprint className="h-4 w-4 text-cyan-300" />Recent gate decisions</div>
          {!data.items.length ? <div className="p-8 text-center text-sm text-zinc-500">No gate-stopped reposts have been recorded yet.</div> : <div className="divide-y divide-white/5">
            {data.items.map((item) => <article key={item.raw_id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3"><div className="mt-0.5 rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--accent-soft)] p-1.5"><CheckCircle2 className="h-4 w-4 text-[color:var(--accent-forest)]" /></div><div><div className="font-medium text-white">Raw #{item.raw_id} stopped as exact repost</div><div className="mt-1 text-xs text-[color:var(--text-muted)]">{date(item.received_at)} · {item.sender || "Sender hidden"} · group {short(item.group_jid)}</div></div></div>
                <div className="text-right text-xs text-zinc-500">matched raw <span className="font-mono text-cyan-200">#{item.repeat_of_raw_id ?? "—"}</span><div className="mt-1 text-emerald-300">{item.decision}</div></div>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr]">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3"><div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Fingerprint</div><div className="mt-1 break-all font-mono text-xs text-zinc-300">{item.fingerprint || "—"}</div><div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Why blocked</div><div className="mt-1 text-xs text-zinc-400">{item.reason}</div></div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3"><div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Incoming evidence preview</div><div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-zinc-300">{item.message_preview || "—"}</div><div className="mt-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Original observation</div><div className="mt-1 text-xs text-zinc-400">Raw #{item.original?.raw_id ?? item.repeat_of_raw_id ?? "—"} · {date(item.original?.received_at ?? null)} · {short(item.original?.group_jid ?? null)}</div></div>
              </div>
            </article>)}
          </div>}
        </section>
      </>}
    </div>
  );
}

export default DedupeGatePage;
