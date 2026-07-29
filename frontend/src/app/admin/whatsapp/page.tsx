"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Ban, RefreshCw, Search, Smartphone } from "lucide-react";
import {
  getAdminWhatsAppSessions,
  updateAdminWhatsAppSession,
  type AdminWhatsAppSession,
} from "@/lib/api";

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange} className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-emerald-500" : "bg-zinc-700"}`}>
      <span className={`absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </button>
  );
}

export default function AdminWhatsAppPage() {
  const [sessions, setSessions] = useState<AdminWhatsAppSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAdminWhatsAppSessions();
      setSessions(result.sessions || []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load WhatsApp sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function updateSession(session: AdminWhatsAppSession, field: "self_chat_enabled" | "is_active") {
    const key = `${session.id}:${field}`;
    setActionKey(key);
    try {
      const updated = await updateAdminWhatsAppSession(session.id, { [field]: !session[field] });
      setSessions((current) => current.map((item) => item.id === session.id ? { ...item, ...updated } : item));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update session");
    } finally {
      setActionKey(null);
    }
  }

  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter((session) => [
      session.instance_name,
      session.display_name,
      session.phone_number_live,
      session.phone_number,
      session.organizations?.name,
      session.organizations?.slug,
      session.broker_id,
    ].some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [query, sessions]);

  return (
    <main className="mx-auto max-w-7xl p-6">
      <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <Link href="/admin" className="mt-1 text-zinc-400 hover:text-white"><ArrowLeft className="h-5 w-5" /></Link>
          <div>
            <h1 className="text-2xl font-bold text-white">WhatsApp Sessions</h1>
            <p className="mt-1 text-sm text-zinc-500">Super-admin control for every workspace phone and self-chat assistant.</p>
          </div>
        </div>
        <button onClick={() => void load()} disabled={loading} className="flex min-h-10 items-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs font-semibold text-zinc-300 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspace, phone, or session"
            className="h-10 w-full rounded-lg border border-white/10 bg-zinc-950 pl-9 pr-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
          />
        </label>
        <div className="text-xs text-zinc-500">{filteredSessions.length} of {sessions.length} sessions</div>
      </div>

      {loading && sessions.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-zinc-500">Loading sessions…</div>
      ) : filteredSessions.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-zinc-500">No sessions match this search.</div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
          <div className="hidden grid-cols-[minmax(11rem,1.4fr)_minmax(9rem,1fr)_6.5rem_7rem_7rem_8rem] items-center gap-4 border-b border-white/10 bg-white/[0.025] px-5 py-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 lg:grid">
            <div>Phone / workspace</div><div>Status</div><div>Messages</div><div>Self-chat</div><div>Access</div><div className="text-right">Actions</div>
          </div>
          <div className="divide-y divide-white/10">
          {filteredSessions.map((session) => {
            const connected = Boolean(session.connected);
            const busy = actionKey?.startsWith(`${session.id}:`) ?? false;
            const organization = session.organizations;
            return (
              <section key={session.id} className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(11rem,1.4fr)_minmax(9rem,1fr)_6.5rem_7rem_7rem_8rem] lg:items-center">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]"><Smartphone className="h-4 w-4 text-zinc-300" /></div>
                  <div className="min-w-0"><div className="truncate text-sm font-semibold text-white">{session.instance_name || session.display_name || "WhatsApp phone"}</div><div className="truncate font-mono text-xs text-zinc-500">{session.phone_number_live || session.phone_number}</div><div className="truncate text-xs text-zinc-400">{organization?.name || "Unknown workspace"}</div></div>
                </div>
                <div><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase ${connected ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>{connected ? "Connected" : session.connection_state || "Offline"}</span></div>
                <div className="text-sm font-medium text-white">{session.total_messages_received?.toLocaleString() || "0"}</div>
                <div className="flex items-center gap-2"><Toggle checked={session.self_chat_enabled !== false} disabled={busy} label="Toggle self-chat assistant" onChange={() => void updateSession(session, "self_chat_enabled")} /><span className="text-xs text-zinc-400">{session.self_chat_enabled !== false ? "On" : "Off"}</span></div>
                <div><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase ${session.is_active !== false ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300"}`}>{session.is_active !== false ? "Allowed" : "Banned"}</span></div>
                <div className="flex justify-end"><button type="button" disabled={busy} onClick={() => { if (window.confirm(session.is_active !== false ? "Ban this WhatsApp session and disconnect it?" : "Restore this WhatsApp session?")) void updateSession(session, "is_active"); }} className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold disabled:opacity-50 ${session.is_active !== false ? "border-red-500/30 text-red-300 hover:bg-red-500/10" : "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"}`}><Ban className="h-3.5 w-3.5" />{session.is_active !== false ? "Ban" : "Restore"}</button></div>
              </section>
            );
          })}
          </div>
        </div>
      )}
    </main>
  );
}
