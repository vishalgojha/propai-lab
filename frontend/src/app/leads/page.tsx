"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CheckCircle2, Clock3, MessageCircle, RefreshCw, Sparkles } from "lucide-react";
import * as api from "@/lib/api";

function matchLabel(match: api.InboundLeadMatch) {
  const listing = match.listing;
  return listing?.title || [listing?.bhk, listing?.building_name, listing?.micro_market].filter(Boolean).join(" · ") || "Matched listing";
}

function waUrl(phone: string, text: string) {
  const digits = phone.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : "";
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<api.InboundLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true); setError("");
    try { setLeads((await api.getInboundLeads()).leads); } catch (err) { setError(err instanceof Error ? err.message : "Lead Desk could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const openCount = useMemo(() => leads.filter((lead) => lead.priority !== "done").length, [leads]);

  async function draft(lead: api.InboundLead, listingId?: number) {
    setBusy(lead.id); setError("");
    try {
      const result = await api.createInboundLeadDraft(lead.id, listingId);
      setLeads((current) => current.map((row) => row.id === lead.id ? { ...row, status: "needs_followup", followup: result.followup } : row));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not prepare a follow-up draft."); }
    finally { setBusy(null); }
  }

  async function openDraft(lead: api.InboundLead) {
    if (!lead.followup?.draft_text || !lead.contact_phone) return;
    setBusy(lead.id);
    try {
      await api.markInboundLeadOpened(lead.id);
      window.open(waUrl(lead.contact_phone, lead.followup.draft_text), "_blank", "noopener,noreferrer");
      setLeads((current) => current.map((row) => {
        if (row.id !== lead.id) return row;
        const next: api.InboundLead = { ...row };
        if (row.followup) next.followup = { id: row.followup.id, draft_text: row.followup.draft_text, status: "opened", outcome: row.followup.outcome };
        return next;
      }));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not open WhatsApp."); }
    finally { setBusy(null); }
  }

  async function complete(lead: api.InboundLead, outcome: string) {
    setBusy(lead.id);
    try { await api.completeInboundLeadFollowup(lead.id, outcome); setLeads((current) => current.map((row) => {
      if (row.id !== lead.id) return row;
      const next: api.InboundLead = { ...row, status: outcome === "closed" ? "closed" : "contacted", priority: "done" };
      if (row.followup) next.followup = { id: row.followup.id, draft_text: row.followup.draft_text, status: "completed", outcome };
      return next;
    })); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not record the lead outcome."); }
    finally { setBusy(null); }
  }

  return <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300"><Sparkles className="h-4 w-4" /> Broker operations</div><h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Lead Desk</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Prioritise inbound enquiries, prepare a grounded reply, and send only after you review it in WhatsApp.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 self-start rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-300 hover:border-white/20 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh</button>
    </div>
    <div className="mt-6 grid gap-3 sm:grid-cols-3"><div className="rounded-xl border border-white/10 bg-white/[0.035] p-4"><div className="text-xs text-zinc-500">Open follow-ups</div><div className="mt-1 text-2xl font-semibold text-white">{openCount}</div></div><div className="rounded-xl border border-white/10 bg-white/[0.035] p-4"><div className="text-xs text-zinc-500">High-priority matches</div><div className="mt-1 text-2xl font-semibold text-emerald-300">{leads.filter((lead) => lead.priority === "high").length}</div></div><div className="rounded-xl border border-white/10 bg-white/[0.035] p-4"><div className="text-xs text-zinc-500">Scope</div><div className="mt-1 text-sm font-medium text-zinc-200">This workspace’s inbound leads</div></div></div>
    {error && <div role="alert" className="mt-5 rounded-lg border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-200">{error}</div>}
    {loading ? <div className="mt-8 rounded-xl border border-white/10 p-8 text-sm text-zinc-500">Loading lead queue…</div> : leads.length === 0 ? <div className="mt-8 rounded-xl border border-white/10 p-10 text-center"><div className="text-sm font-semibold text-white">No inbound leads yet</div><p className="mt-2 text-sm text-zinc-500">Leads from connected providers will appear here with explainable listing matches.</p></div> : <div className="mt-8 space-y-3">{leads.map((lead) => { const best = lead.matches[0]; const draftText = lead.followup?.draft_text; const done = lead.priority === "done"; return <article key={lead.id} className={`rounded-2xl border p-5 ${done ? "border-white/5 bg-white/[0.015] opacity-70" : "border-white/10 bg-white/[0.035]"}`}><div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${lead.priority === "high" ? "bg-emerald-400/15 text-emerald-300" : lead.priority === "review" ? "bg-amber-400/15 text-amber-200" : "bg-white/10 text-zinc-300"}`}>{lead.priority === "done" ? "Completed" : `${lead.priority || "normal"} priority`}</span><span className="text-xs text-zinc-500">{lead.provider}</span></div><h2 className="mt-3 text-lg font-semibold text-white">{lead.contact_name || "Unnamed enquiry"}</h2><p className="mt-1 text-xs text-zinc-500">{lead.contact_phone || lead.contact_email || "Contact details unavailable"}</p>{lead.enquiry_text && <p className="mt-3 max-w-2xl whitespace-pre-wrap text-sm leading-6 text-zinc-300">{lead.enquiry_text}</p>}</div><div className="flex shrink-0 flex-col gap-2 sm:flex-row lg:flex-col">{!done && !draftText && <button type="button" onClick={() => void draft(lead)} disabled={busy === lead.id} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"><Sparkles className="h-3.5 w-3.5" />{busy === lead.id ? "Preparing…" : "Prepare follow-up"}</button>}{draftText && lead.contact_phone && !done && <button type="button" onClick={() => void openDraft(lead)} disabled={busy === lead.id} className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black disabled:opacity-50"><MessageCircle className="h-3.5 w-3.5" />Review in WhatsApp <ArrowUpRight className="h-3.5 w-3.5" /></button>}{draftText && !done && <button type="button" onClick={() => void complete(lead, "closed")} disabled={busy === lead.id} className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:border-white/20"><CheckCircle2 className="h-3.5 w-3.5" />Close lead</button>}</div></div>{best && <div className="mt-5 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4"><div className="flex items-center justify-between gap-3"><div className="text-xs font-semibold uppercase tracking-wider text-emerald-200">Best explainable match</div><span className="text-xs text-emerald-300">{Math.round(best.match_score)} score</span></div><div className="mt-2 text-sm font-medium text-white">{matchLabel(best)}</div>{best.listing?.availability_status && <div className="mt-1 text-xs text-zinc-400">Availability: {best.listing.availability_status}</div>}{!draftText && !done && lead.matches.length > 1 && <button type="button" onClick={() => void draft(lead, best.listing_id)} className="mt-3 text-xs font-medium text-cyan-300 underline underline-offset-2">Use this match in the draft</button>}</div>}{draftText && !done && <div className="mt-5 rounded-xl border border-sky-400/15 bg-sky-400/[0.04] p-4"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-sky-200"><Clock3 className="h-3.5 w-3.5" /> Draft — review before sending</div><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-200">{draftText}</p><p className="mt-3 text-[11px] text-zinc-500">Opening WhatsApp does not send automatically. You remain in control of the final message.</p></div>}</article>; })}</div>}
  </main>;
}
