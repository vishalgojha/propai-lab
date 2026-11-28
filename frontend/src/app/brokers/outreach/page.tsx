"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";
import { Lock, MessageCircle, RefreshCw } from "lucide-react";
import {
  OUTREACH_STORE_KEY, brokerStatusKey, buildWaLink, parseStore, resolveBrokerPhone,
  type OutreachStatus, type OutreachStore,
} from "@/lib/brokerOutreach";
import { brokerGroupInviteUrl } from "@/lib/brokerGroupInvite";

// Draft only. The owner edits and approves the wording on this page before use.
const BASE_DRAFT =
  "Hi, this is Vishal. I built PropAI so brokers don't have to scroll through WhatsApp groups: you search captured group messages by locality, BHK, budget and furnishing, and see the original posts. It works best with an assistant like Instinct. If you want to try it, reply here and I'll send the setup steps. If something doesn't work, just send me a screenshot.";
const GROUP_INVITE = brokerGroupInviteUrl();
// Owner asked for the brokers group link in the prefilled message (Nov 28). Optional line, link only.
const DRAFT_TEMPLATE = GROUP_INVITE ? `${BASE_DRAFT}\n\nPropAI brokers WhatsApp group (optional): ${GROUP_INVITE}` : BASE_DRAFT;
// A saved template that is still the previous unedited default moves to the new default; edited templates are kept.
const PREVIOUS_DEFAULT_TEMPLATES = [BASE_DRAFT];

type Row = {
  id: number | string;
  canonical_name?: string;
  primary_phone?: string;
  listing_count?: number;
  requirement_count?: number;
  last_seen_at?: string;
  markets?: { micro_market: string }[];
  groups?: { group_name: string }[];
};

const PAGE = 100;
const STATUS_LABEL: Record<OutreachStatus, string> = { sent: "Sent", replied: "Replied", skipped: "Skipped" };

function daysAgo(ts?: string) {
  const t = ts ? new Date(ts).getTime() : NaN;
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 86400000;
}

export default function BrokerOutreachPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<"forbidden" | "unavailable" | null>(null);
  const [store, setStore] = useState<OutreachStore>({ template: DRAFT_TEMPLATE, assumeIndia: true, statuses: {} });
  // Marks live in PropAI (per workspace) so they follow him across devices.
  const [marks, setMarks] = useState<Record<string, { status: OutreachStatus; at: string }>>({});
  const [marksState, setMarksState] = useState<"loading" | "synced" | "failed">("loading");
  const [markError, setMarkError] = useState("");
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [mix, setMix] = useState<"all" | "supply" | "demand">("all");
  const [activeDays, setActiveDays] = useState(0);
  const [minListings, setMinListings] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"open" | "done" | "all">("open");
  const [onlySendable, setOnlySendable] = useState(true);

  useEffect(() => {
    setStore(parseStore(window.localStorage.getItem(OUTREACH_STORE_KEY), DRAFT_TEMPLATE, PREVIOUS_DEFAULT_TEMPLATES));
    setReady(true);
  }, []);
  useEffect(() => {
    if (ready) window.localStorage.setItem(OUTREACH_STORE_KEY, JSON.stringify(store));
  }, [store, ready]);

  useEffect(() => {
    let cancelled = false;
    api.fetchJSON<{ marks: { broker_key: string; status: OutreachStatus; marked_at: string }[] }>("/broker-outreach/marks")
      .then((d) => {
        if (cancelled) return;
        const next: typeof marks = {};
        for (const m of d.marks || []) next[m.broker_key] = { status: m.status, at: m.marked_at };
        setMarks(next);
        setMarksState("synced");
      })
      .catch(() => { if (!cancelled) setMarksState("failed"); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.getBrokers(PAGE, 0);
          if (cancelled) return;
          setRows(data?.brokers || []);
          setTotal(typeof data?.total === "number" ? data.total : null);
          setError(null);
          setLoading(false);
          return;
        } catch (e) {
          const forbidden = /^403/.test(e instanceof Error ? e.message : String(e));
          if (forbidden || attempt === 2) {
            if (!cancelled) { setError(forbidden ? "forbidden" : "unavailable"); setLoading(false); }
            return;
          }
          await new Promise((r) => setTimeout(r, 750));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasMore = total !== null ? rows.length < total : false;
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await api.getBrokers(PAGE, rows.length);
      const next: Row[] = data?.brokers || [];
      setRows((cur) => {
        const seen = new Set(cur.map((r) => String(r.id)));
        return [...cur, ...next.filter((r) => !seen.has(String(r.id)))];
      });
    } catch { /* keep what is loaded */ }
    setLoadingMore(false);
  };

  const setStatus = async (key: string, status: OutreachStatus | null) => {
    if (marksState !== "synced") { setMarkError("Marks could not be loaded from PropAI, so nothing was saved. Reload and try again."); return; }
    const before = marks[key];
    setMarkError("");
    setMarks((m) => {
      const n = { ...m };
      if (status) n[key] = { status, at: new Date().toISOString() }; else delete n[key];
      return n;
    });
    try {
      await api.fetchJSON("/broker-outreach/marks", {
        method: status ? "PUT" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(status ? { broker_key: key, status } : { broker_key: key }),
      });
    } catch {
      setMarks((m) => { const n = { ...m }; if (before) n[key] = before; else delete n[key]; return n; });
      setMarkError("Could not save that mark. It was not recorded.");
    }
  };

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .map((r) => {
        const phone = resolveBrokerPhone(r.primary_phone, store.assumeIndia);
        const key = brokerStatusKey(r.primary_phone);
        return { r, phone, key, st: key ? marks[key] : undefined };
      })
      .filter(({ r, phone, st }) => {
        const sup = r.listing_count || 0, dem = r.requirement_count || 0;
        if (mix === "supply" && !(sup >= dem * 3 && sup > 0)) return false;
        if (mix === "demand" && !(dem >= sup * 2 && dem > 0)) return false;
        if (activeDays && daysAgo(r.last_seen_at) > activeDays) return false;
        if (minListings && sup < minListings) return false;
        if (statusFilter === "open" && st) return false;
        if (statusFilter === "done" && !st) return false;
        if (onlySendable && phone.kind !== "international" && phone.kind !== "assumed_india") return false;
        if (q) {
          const text = [r.canonical_name, ...(r.markets || []).map((m) => m.micro_market), ...(r.groups || []).map((g) => g.group_name)].join(" ").toLowerCase();
          if (!text.includes(q)) return false;
        }
        return true;
      });
  }, [rows, store, marks, query, mix, activeDays, minListings, statusFilter, onlySendable]);

  const sentToday = Object.values(marks).filter((s) => s.status === "sent" && s.at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
  const ambiguousCount = rows.filter((r) => resolveBrokerPhone(r.primary_phone, false).kind === "ambiguous").length;

  if (error === "forbidden") {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <Lock className="mx-auto h-10 w-10 text-amber-400" />
        <h2 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">Broker outreach is a Super Admin view</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-400">Broker numbers are restricted to platform administrators.</p>
      </div>
    );
  }
  if (error === "unavailable") {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <RefreshCw className="mx-auto h-10 w-10 text-amber-400" />
        <h2 className="mt-4 text-lg font-semibold text-[var(--text-primary)]">Broker profiles are temporarily unavailable</h2>
      </div>
    );
  }

  const field = "rounded-lg border border-white/10 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200";
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4">
      <div>
        <Link href="/brokers" className="text-xs text-zinc-500 hover:text-zinc-300">← Broker Profiles</Link>
        <h1 className="mt-1 text-xl font-semibold text-[var(--text-primary)]">Manual broker outreach</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Opens a WhatsApp chat with your message filled in. Nothing is sent from here: you send it yourself, then mark it.
          Opening a chat does not mark it sent. Marks are saved in PropAI for this workspace.
        </p>
      </div>

      {marksState === "failed" && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">Saved marks could not be loaded, so marking is turned off until you reload. Existing marks are not shown.</p>}
      {markError && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">{markError}</p>}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
        <label className="text-xs font-semibold uppercase tracking-wider text-zinc-500" htmlFor="tpl">Message (draft, edit before use)</label>
        <textarea id="tpl" value={store.template} onChange={(e) => setStore((s) => ({ ...s, template: e.target.value }))}
          rows={5} className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-900 p-3 text-sm text-zinc-200" />
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
          <span>{store.template.length} characters, same text for every broker</span>
          <button className="underline hover:text-zinc-300" onClick={() => setStore((s) => ({ ...s, template: DRAFT_TEMPLATE }))}>Reset to draft</button>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, market, group" className={`${field} min-w-[14rem] flex-1`} />
          <select value={mix} onChange={(e) => setMix(e.target.value as typeof mix)} className={field} aria-label="Type">
            <option value="all">Supply + demand</option><option value="supply">Supply</option><option value="demand">Demand</option>
          </select>
          <select value={activeDays} onChange={(e) => setActiveDays(Number(e.target.value))} className={field} aria-label="Last active">
            <option value={0}>Any activity date</option><option value={7}>Seen in 7 days</option><option value={30}>Seen in 30 days</option><option value={90}>Seen in 90 days</option>
          </select>
          <select value={minListings} onChange={(e) => setMinListings(Number(e.target.value))} className={field} aria-label="Minimum listings">
            <option value={0}>Any listings</option><option value={1}>1+ listings</option><option value={5}>5+ listings</option><option value={20}>20+ listings</option>
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className={field} aria-label="Status">
            <option value="open">Not marked yet</option><option value="done">Marked (sent / replied / skipped)</option><option value="all">All</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
          <label className="flex items-center gap-2"><input type="checkbox" checked={onlySendable} onChange={(e) => setOnlySendable(e.target.checked)} /> Only numbers with a usable WhatsApp link</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={store.assumeIndia} onChange={(e) => setStore((s) => ({ ...s, assumeIndia: e.target.checked }))} /> Add +91 to 10-digit Indian numbers (6-9 start)</label>
        </div>
        <p className="text-xs text-zinc-500">
          {loading ? "Loading profiles…" : `${view.length} shown of ${rows.length} loaded${total !== null ? ` (${total} profiles in total)` : ""}. `}
          {!loading && ambiguousCount > 0 && !store.assumeIndia ? `${ambiguousCount} loaded numbers have no link: no stored country code or an unrecognised format. Turn on the +91 option to link bare 10-digit ones. ` : ""}
          Marked sent today across all brokers (including ones not shown by these filters): {sentToday}.
        </p>
      </section>

      <div className="space-y-2">
        {view.map(({ r, phone, key, st }) => {
          const link = phone.kind === "international" || phone.kind === "assumed_india" ? buildWaLink(phone.e164digits, store.template) : "";
          const shownPhone = phone.kind === "international" || phone.kind === "assumed_india" ? `+${phone.e164digits}` : "";
          return (
            <article key={String(r.id)} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[var(--surface)] p-3">
              <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                <div className="truncate font-medium text-[var(--text-primary)]">{r.canonical_name || shownPhone || "Unnamed broker"}</div>
                <div className="mt-0.5 truncate text-xs text-zinc-500">
                  {(r.listing_count || 0)} listings · {(r.requirement_count || 0)} reqs · seen {r.last_seen_at ? new Date(r.last_seen_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
                  {(r.markets || [])[0] ? ` · ${(r.markets || [])[0].micro_market}` : ""}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {shownPhone ? `${shownPhone}${phone.kind === "assumed_india" ? " (+91 added)" : ""}` : <span className="text-amber-400/80">{phone.kind === "none" ? phone.reason : phone.kind === "ambiguous" ? `No link: ${phone.reason}` : ""}</span>}
                </div>
              </div>
              {st && <span className="rounded border border-white/10 px-2 py-0.5 text-xs text-zinc-300">{STATUS_LABEL[st.status]} {new Date(st.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>}
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500">
                  <MessageCircle className="h-3.5 w-3.5" /> Open chat
                </a>
              ) : null}
              {key && (
                <div className="flex gap-1 text-xs">
                  <button className="rounded border border-white/15 px-2 py-1 text-zinc-300 hover:bg-white/10" onClick={() => void setStatus(key, "sent")}>Mark sent</button>
                  <button className="rounded border border-white/15 px-2 py-1 text-zinc-300 hover:bg-white/10" onClick={() => void setStatus(key, "replied")}>Replied</button>
                  <button className="rounded border border-white/15 px-2 py-1 text-zinc-300 hover:bg-white/10" onClick={() => void setStatus(key, "skipped")}>Skip</button>
                  {st && <button className="rounded border border-white/15 px-2 py-1 text-zinc-500 hover:bg-white/10" onClick={() => void setStatus(key, null)}>Undo</button>}
                </div>
              )}
            </article>
          );
        })}
        {!loading && view.length === 0 && <p className="py-8 text-center text-sm text-zinc-500">No brokers match these filters.</p>}
      </div>
      {hasMore && (
        <button onClick={loadMore} disabled={loadingMore} className="mx-auto block rounded-lg border border-white/15 px-4 py-2 text-sm text-zinc-300 hover:bg-white/10">
          {loadingMore ? "Loading…" : `Load ${PAGE} more profiles`}
        </button>
      )}
    </div>
  );
}
