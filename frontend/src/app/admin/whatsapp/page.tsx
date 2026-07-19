"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Smartphone } from "lucide-react";
import {
  getAdminWhatsAppSessions,
  updateAdminWhatsAppSession,
  type AdminWhatsAppSession,
} from "@/lib/api";

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange} className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-emerald-500" : "bg-zinc-700"}`}>
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

export default function AdminWhatsAppPage() {
  const [sessions, setSessions] = useState<AdminWhatsAppSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      {loading && sessions.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-zinc-500">Loading sessions…</div>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl border border-white/10 p-12 text-center text-zinc-500">No WhatsApp phones configured.</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {sessions.map((session) => {
            const connected = Boolean(session.connected);
            const busy = actionKey?.startsWith(`${session.id}:`) ?? false;
            const organization = session.organizations;
            return (
              <section key={session.id} className="rounded-xl border border-white/10 bg-zinc-950 p-5">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]"><Smartphone className="h-5 w-5 text-zinc-300" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate font-semibold text-white">{session.instance_name || session.display_name || "WhatsApp phone"}</h2>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${connected ? "bg-emerald-500/15 text-emerald-300" : "bg-zinc-800 text-zinc-400"}`}>{connected ? "Connected" : session.connection_state || "Offline"}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-zinc-500">{session.phone_number_live || session.phone_number}</div>
                    <div className="mt-1 text-xs text-zinc-400">{organization?.name || session.organization_id}</div>
                  </div>
                </div>

                <div className="my-5 grid grid-cols-2 divide-x divide-white/10 rounded-lg border border-white/10 py-3 text-center">
                  <div><div className="text-[10px] uppercase text-zinc-600">Messages</div><div className="mt-1 text-sm font-semibold text-white">{session.total_messages_received?.toLocaleString() || "0"}</div></div>
                  <div><div className="text-[10px] uppercase text-zinc-600">Broker ID</div><div className="mt-1 truncate px-2 font-mono text-xs text-zinc-300">{session.broker_id || "—"}</div></div>
                </div>

                <div className="space-y-3 border-y border-white/10 py-4">
                  <div className="flex items-center justify-between gap-4"><div><div className="text-sm font-medium text-white">Self-chat assistant</div><div className="text-xs text-zinc-500">Allow commands sent to the phone itself</div></div><Toggle checked={session.self_chat_enabled !== false} disabled={busy} label="Toggle self-chat assistant" onChange={() => void updateSession(session, "self_chat_enabled")} /></div>
                  <div className="flex items-center justify-between gap-4"><div><div className="text-sm font-medium text-white">Enabled</div><div className="text-xs text-zinc-500">Flip off to ban this session</div></div><Toggle checked={session.is_active !== false} disabled={busy} label="Toggle session enabled" onChange={() => void updateSession(session, "is_active")} /></div>
                </div>

              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
