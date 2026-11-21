"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "@/lib/api";

type Group = { group_jid: string; group_name: string };
type Sources = { groups: Group[]; active_sources: (Group & { confirmed_at: string; message_count?: number; last_message_at?: string | null })[]; consent_version: string; consent_text: string };

/** Review hints use activity counters only. They are NOT recommendations to
 * uncheck: a quiet group can still be the right one to share. */
const STALE_DAYS = 90;
function reviewHint(g: { message_count?: number; last_message_at?: string | null }): string | null {
  if (!g.last_message_at) return "No group activity recorded yet.";
  const days = (Date.now() - new Date(g.last_message_at).getTime()) / 86400000;
  if (days >= STALE_DAYS) return `Quiet for ${Math.floor(days)} days.`;
  return null;
}

// No extraction selection, directory default, or typed-publication API is used here.
export function RawGroupSharing({ connectionId }: { connectionId: number }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const currentConnection = useRef(connectionId);
  currentConnection.current = connectionId;
  const [data, setData] = useState<Sources | null>(null);
  const [dataConnectionId, setDataConnectionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const policy = await fetchJSON<{ enabled: boolean }>("/external/v1/market/policy");
      if (currentConnection.current !== connectionId) return;
      setAvailable(policy.enabled);
      if (!policy.enabled) { setData(null); setDataConnectionId(null); setOpen(false); return; }
      const next = await fetchJSON<Sources>(`/external/v1/market/raw-sources?whatsapp_connection_id=${connectionId}`);
      if (currentConnection.current === connectionId) { setData(next); setDataConnectionId(connectionId); }
    } finally {
      if (currentConnection.current === connectionId) setLoading(false);
    }
  }, [connectionId]);
  useEffect(() => {
    setSelected(new Set()); setConfirmed(false); setOpen(false); setData(null); setDataConnectionId(null); setAvailable(null); setNotice(null); setError(null);
    let active = true;
    // A failed policy/load never inherits another connection's sharing choices.
    load().catch(() => { if (active) setError("Raw sharing settings could not be loaded. No groups were changed."); });
    return () => { active = false; };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') || []);
    focusable()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { setOpen(false); setSelected(new Set()); setConfirmed(false); }
      if (event.key !== "Tab") return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); openerRef.current?.focus(); };
  }, [open, busy]);
  const scopedData = dataConnectionId === connectionId ? data : null;
  const fresh = !!scopedData && !loading && !error;
  const activeJids = new Set(scopedData?.active_sources.map(g => g.group_jid) || []);
  const chosen = (scopedData?.groups || []).filter(g => selected.has(g.group_jid) && !activeJids.has(g.group_jid));
  const resetChoice = () => { setSelected(new Set()); setConfirmed(false); setQuery(""); };
  const grant = async () => {
    if (!fresh || !scopedData || !confirmed || chosen.length === 0 || chosen.length > 200 || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await fetchJSON("/external/v1/market/raw-sources", { method: "PUT", body: JSON.stringify({
        whatsapp_connection_id: connectionId, group_jids: chosen.map(g => g.group_jid),
        consent_version: scopedData.consent_version, confirmed: true, enabled: true,
      }) });
      resetChoice(); setOpen(false);
      await load();
      setNotice("Raw sharing saved for the named groups. Only posts sent and received after confirmation are eligible. Extraction and typed-listing publication were not changed.");
    } catch {
      setConfirmed(false);
      setError("Raw sharing was not verified. Reload its current state before retrying; extraction and typed-listing settings were not changed.");
    } finally { setBusy(false); }
  };
  const revoke = async (group: Group) => {
    if (!fresh || !scopedData || busy || !window.confirm(`Stop raw-message cross-search for ${group.group_name} (${group.group_jid})? Existing search references will stop working. Extraction and typed listings are unchanged.`)) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await fetchJSON("/external/v1/market/raw-sources", { method: "PUT", body: JSON.stringify({
        whatsapp_connection_id: connectionId, group_jids: [group.group_jid],
        consent_version: scopedData.consent_version, confirmed: false, enabled: false,
      }) });
      await load(); setNotice(`Raw sharing removed for ${group.group_name}. Extraction and typed-listing publication were not changed.`);
    } catch { setError("Removal was not verified. Reload the current raw-sharing state before retrying."); }
    finally { setBusy(false); }
  };
  if (available === false) return null;
  return <section aria-label="Raw group sharing" className="mt-4 rounded-xl border border-cyan-400/25 bg-cyan-500/[0.03] p-4 text-xs text-zinc-200">
    <h3 className="text-sm font-semibold text-white">Raw-message sharing with other PropAI brokers</h3>
    <p className="mt-2 leading-5">Choose these groups separately. This does not start extraction, select extraction groups, publish typed listings, or expose DMs. Directory ticks elsewhere are not sharing permission.</p>
    <details className="mt-3 rounded-lg border border-cyan-400/20 p-3 text-zinc-300">
      <summary className="cursor-pointer font-medium text-cyan-100">Which groups should I share?</summary>
      <div className="mt-2 space-y-2 leading-5">
        <p>Consider property broker networks, rental or sale requirements, and locality or project groups. A name is only a clue, not proof of permission.</p>
        <p>Leave personal, family, health, sensitive and unrelated groups unchecked. If a group is unclear or mixed-purpose, leave it unchecked and confirm its purpose first.</p>
        <p>Sharing includes other members&apos; messages. Respect the group rules and members&apos; expectations, and choose only groups you have authority to share. Contact masking reduces exposure, but is not a guarantee that text has no identifying or sensitive details.</p>
        <p>You choose the exact named groups and confirm them. No new groups are selected by default or added automatically later. Only eligible new messages are shared, not earlier chats or DMs. This does not start extraction or grant another broker reader access.</p>
      </div>
    </details>
    <p role="status" aria-live="polite" className="mt-2 text-zinc-400">{fresh
      ? `${scopedData.active_sources.length} groups currently shared.`
      : scopedData
        ? `Last verified: ${scopedData.active_sources.length} groups shared. ${loading ? "Checking current sharing state..." : "Current sharing state could not be verified."}`
        : loading ? "Loading raw-sharing state. Shared group count is not known yet." : "Raw-sharing state is unavailable. Shared group count is unknown."}</p>
    <p className="mt-1 text-zinc-400">Contact numbers stay hidden until a broker chooses a specific option.</p>
    {error && !open && <p role="alert" className="mt-3 rounded border border-red-400/30 p-2 text-red-200">{error}</p>}
    {notice && <p role="status" className="mt-3 text-emerald-200">{notice}</p>}
    {!!scopedData?.active_sources.length && <p className="mt-2 text-[11px] text-zinc-500">Review hints use activity counters only; they are not recommendations to remove sharing.</p>}
    <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto">
      {scopedData?.active_sources.map(g => { const hint = reviewHint(g); return <li key={g.group_jid} className="flex items-center justify-between gap-3 rounded border border-white/10 p-2"><span className="min-w-0 break-words">{g.group_name}<span className="block text-[10px] text-zinc-500">{g.group_jid}</span>{hint && <span className="mt-0.5 block text-[10px] text-amber-200/80">Review hint: {hint} Remove only if you judge the group not property-related.</span>}</span><button type="button" disabled={busy || !fresh} onClick={() => void revoke(g)} className="shrink-0 rounded border border-red-400/30 px-2 py-1 text-red-200 disabled:opacity-40">Remove raw sharing</button></li>; })}
    </ul>
    <button ref={openerRef} type="button" disabled={!fresh || busy} onClick={() => { resetChoice(); setError(null); setOpen(true); }} className="mt-3 rounded border border-cyan-400/40 px-3 py-2 text-cyan-100 disabled:opacity-40">Choose groups for raw sharing</button>
    <button type="button" disabled={busy || loading} onClick={() => { setError(null); void load().catch(() => setError("Could not reload raw sharing settings.")); }} className="ml-3 text-zinc-400">Reload sharing state</button>
    {open && scopedData && <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="raw-sharing-title" className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90dvh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-white/15 bg-zinc-950 shadow-xl">
        <div className="border-b border-white/10 p-4"><h3 id="raw-sharing-title" className="text-sm font-semibold text-white">Choose exact groups for raw sharing</h3><p className="mt-2 leading-5">No groups are selected by default. Choose only property groups you have authority to share. Names are supplied by WhatsApp and are not proof of permission.</p><input aria-label="Search raw-sharing groups" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search groups" className="mt-3 w-full rounded border border-white/20 bg-zinc-900 p-2" />{error && <p role="alert" className="mt-3 rounded border border-red-400/40 bg-red-500/10 p-2 text-red-200">{error}</p>}</div>
        <div className="min-h-0 overflow-y-auto p-4">
          <div className="max-h-48 space-y-2 overflow-y-auto">
            {scopedData.groups.filter(g => !activeJids.has(g.group_jid) && g.group_name.toLowerCase().includes(query.toLowerCase())).map(g => <label key={g.group_jid} className="flex items-start gap-2 rounded border border-white/10 p-2"><input type="checkbox" disabled={busy || (!selected.has(g.group_jid) && selected.size >= 200)} checked={selected.has(g.group_jid)} onChange={e => { setConfirmed(false); setSelected(current => { const next = new Set(current); if (e.target.checked) next.add(g.group_jid); else next.delete(g.group_jid); return next; }); }} className="mt-1" /><span className="min-w-0 break-words">{g.group_name}<span className="block text-[10px] text-zinc-500">{g.group_jid}</span></span></label>)}
          </div>
          <h4 className="mt-4 font-semibold text-cyan-100">Review {chosen.length} exact groups to share</h4>
          <ul aria-label="Groups to share" className="mt-2 max-h-32 list-inside list-disc overflow-y-auto break-words text-cyan-100">{chosen.map(g => <li key={g.group_jid}>{g.group_name} ({g.group_jid})</li>)}</ul>
          <p className="mt-3 leading-5">{scopedData.consent_text}</p><p className="mt-2 leading-5 text-zinc-400">Only messages both posted and received after this confirmation qualify. No archive is copied. Extraction and typed-listing publication are not changed.</p>
          <label className="mt-3 flex items-start gap-2 rounded border border-cyan-400/30 p-3"><input aria-label="Confirm authority for named raw-sharing groups" type="checkbox" disabled={busy || chosen.length === 0} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-1" /><span>I have authority to share the {chosen.length} named groups above with other authenticated PropAI brokers for property-related cross-search, and I agree.</span></label>
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t border-white/10 p-4"><button type="button" disabled={busy} onClick={() => { resetChoice(); setOpen(false); }} className="rounded border border-white/20 px-3 py-2">Cancel</button><button type="button" disabled={busy || !fresh || !confirmed || chosen.length === 0 || chosen.length > 200} onClick={() => void grant()} className="rounded border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-cyan-100 disabled:opacity-40">{busy ? "Saving..." : `Share ${chosen.length} named groups`}</button></div>
      </div>
    </div>}
  </section>;
}
