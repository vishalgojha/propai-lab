"use client";

import { useEffect, useState } from "react";
import { fetchJSON } from "@/lib/api";

type Group = { group_jid: string; group_name: string };
type Grant = { group_jid: string; revoked_at: string | null };
type Policy = { sources: Grant[]; consent_version: string; consent_text: string; default_enabled: false };

export default function ContactSourceConsent() {
  const [phones, setPhones] = useState<{ id: number; display_name?: string }[]>([]);
  const [connection, setConnection] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [writeBlocked, setWriteBlocked] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    fetchJSON<{ phones: { id: number; display_name?: string }[] }>("/phones?include_live=false")
      .then(x => setPhones(x.phones || [])).catch(() => setMessage("Could not load connections."));
  }, []);
  useEffect(() => {
    let active = true;
    setGroups([]); setPolicy(null); setSelected([]); setConfirmed(false); setMessage("");
    if (!connection) return () => { active = false; };
    setBusy(true);
    Promise.all([
      fetchJSON<{ active_sources: Group[] }>(`/external/v1/market/raw-sources?whatsapp_connection_id=${encodeURIComponent(connection)}`),
      fetchJSON<Policy>(`/external/v1/market/contact-sources?whatsapp_connection_id=${encodeURIComponent(connection)}`),
    ]).then(([raw, contacts]) => {
      if (active) { setGroups(raw.active_sources || []); setPolicy(contacts); setWriteBlocked(false); }
    }).catch(() => { if (active) setMessage("Could not load sharing permissions. Nothing changed."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [connection, reload]);
  async function save(enabled: boolean) {
    if (writeBlocked || !policy || !selected.length || (enabled && !confirmed)) return;
    setBusy(true); setMessage("");
    try {
      await fetchJSON("/external/v1/market/contact-sources", { method: "PUT", body: JSON.stringify({
        whatsapp_connection_id: Number(connection), group_jids: selected, consent_version: policy.consent_version,
        confirmed: enabled && confirmed, enabled,
      }) });
      const next = await fetchJSON<Policy>(`/external/v1/market/contact-sources?whatsapp_connection_id=${encodeURIComponent(connection)}`);
      setPolicy(next); setSelected([]); setConfirmed(false);
      setMessage(enabled ? "Contact sharing enabled for future posts in the selected sources." : "Automatic contact sharing disabled for selected sources.");
    } catch { setWriteBlocked(true); setSelected([]); setConfirmed(false); setMessage("Could not verify the change. Reload permissions before trying again."); }
    finally { setBusy(false); }
  }
  return <section className="mt-6 w-full min-w-0 rounded-2xl border border-white/10 p-4 sm:p-6" aria-labelledby="contact-sharing-title">
    <h2 id="contact-sharing-title" className="font-semibold text-white">Contacts alongside property results</h2>
    <p className="mt-2 text-sm text-zinc-400">Optional, off by default. Existing sharing permissions are not upgraded. Only sources you already share are listed.</p>
    <label className="mt-4 block text-sm text-zinc-300">Connection
      <select aria-label="Contact sharing connection" value={connection} disabled={busy} onChange={e => setConnection(e.target.value)} className="mt-1 block w-full min-w-0 rounded border border-white/20 bg-zinc-900 p-2 text-white">
        <option value="">Choose a connection</option>
        {phones.map(p => <option key={p.id} value={p.id}>{p.display_name || `Connection ${p.id}`}</option>)}
      </select>
    </label>
    {busy && <p role="status" className="mt-3 text-sm text-zinc-400">Loading or saving permissions...</p>}
    {policy && <>
      <p className="mt-4 text-sm leading-6 text-zinc-300">{policy.consent_text}</p>
      <fieldset disabled={busy} className="mt-4 space-y-2"><legend className="mb-2 text-sm text-zinc-400">Choose exact shared sources. Nothing is preselected.</legend>
        {!groups.length && <p className="text-sm text-zinc-400">No currently shared sources on this connection.</p>}
        {groups.map(g => <label key={g.group_jid} className="flex min-w-0 items-start gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={selected.includes(g.group_jid)} onChange={e => { setSelected(s => e.target.checked ? [...s,g.group_jid] : s.filter(x => x !== g.group_jid)); setConfirmed(false); }} />
          <span className="min-w-0 break-words">{g.group_name}<span className="block text-xs text-zinc-400">{policy.sources.some(s => s.group_jid === g.group_jid && !s.revoked_at) ? "Automatic contacts enabled" : "Current masked-contact policy"}</span></span>
        </label>)}
      </fieldset>
      <label className="mt-4 flex items-start gap-2 text-sm text-zinc-300"><input type="checkbox" checked={confirmed} disabled={busy || !selected.length} onChange={e => setConfirmed(e.target.checked)} /><span>I agree to this separate contact-disclosure permission for the selected sources.</span></label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" disabled={busy || writeBlocked || !selected.length || !confirmed} onClick={() => void save(true)} className="rounded border border-amber-300/40 px-3 py-2 text-sm text-amber-200 disabled:opacity-40">Enable for future posts</button>
        <button type="button" disabled={busy || writeBlocked || !selected.length} onClick={() => void save(false)} className="rounded border border-white/20 px-3 py-2 text-sm text-zinc-200 disabled:opacity-40">Disable automatic contacts</button>
      </div>
    </>}
    {connection && <button type="button" disabled={busy} onClick={() => setReload(x => x+1)} className="mt-4 block text-sm text-zinc-300 underline">Reload permissions</button>}
    {message && <p role="status" className="mt-3 text-sm text-zinc-300">{message}</p>}
  </section>;
}
