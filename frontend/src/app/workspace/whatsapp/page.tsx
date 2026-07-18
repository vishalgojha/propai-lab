"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, MessageSquareText, Phone, RefreshCcw } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface WhatsAppAccessRule {
  id: number | null;
  team_member_id: number;
  member_name: string;
  member_email: string;
  whatsapp_connection_id: number;
  whatsapp_number: string;
  instance_name: string;
  broker_id: string;
  can_send: boolean;
  can_view_messages: boolean;
  is_explicit: boolean;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${checked ? "bg-emerald-500" : "bg-zinc-700"}`}
    >
      <span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

export default function WhatsAppAccessPage() {
  const [rules, setRules] = useState<WhatsAppAccessRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAccess = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJSON<{ access: WhatsAppAccessRule[] }>("/workspace/whatsapp-access");
      setRules(data.access || []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load WhatsApp access");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAccess(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAccess]);

  const members = useMemo(() => {
    const grouped = new Map<number, { name: string; email: string; rules: WhatsAppAccessRule[] }>();
    for (const rule of rules) {
      const current = grouped.get(rule.team_member_id) || { name: rule.member_name, email: rule.member_email, rules: [] };
      current.rules.push(rule);
      grouped.set(rule.team_member_id, current);
    }
    return Array.from(grouped.entries());
  }, [rules]);

  async function updateRule(rule: WhatsAppAccessRule, field: "can_send" | "can_view_messages") {
    const key = `${rule.team_member_id}:${rule.whatsapp_connection_id}:${field}`;
    setSavingKey(key);
    setError(null);
    const next = { ...rule, [field]: !rule[field], is_explicit: true };
    setRules((current) => current.map((item) =>
      item.team_member_id === rule.team_member_id && item.whatsapp_connection_id === rule.whatsapp_connection_id ? next : item
    ));
    try {
      await fetchJSON("/workspace/whatsapp-access", {
        method: "PUT",
        body: JSON.stringify({
          team_member_id: next.team_member_id,
          whatsapp_number: next.whatsapp_number,
          can_send: next.can_send,
          can_view_messages: next.can_view_messages,
        }),
      });
    } catch (caught) {
      setRules((current) => current.map((item) =>
        item.team_member_id === rule.team_member_id && item.whatsapp_connection_id === rule.whatsapp_connection_id ? rule : item
      ));
      setError(caught instanceof Error ? caught.message : "Could not save access rule");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl p-6 md:p-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">WhatsApp Access</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">Choose which connected number each team member can use to view conversations or send replies from Market Inbox.</p>
        </div>
        <button onClick={() => void loadAccess()} disabled={loading} className="flex min-h-10 items-center gap-2 rounded-lg border border-white/10 bg-zinc-900 px-3 text-xs font-semibold text-zinc-300 hover:text-white disabled:opacity-50">
          <RefreshCcw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {error && <div className="mb-5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}
      {loading && rules.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-zinc-950 p-12 text-center text-sm text-zinc-500">Loading team and phones…</div>
      ) : members.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-zinc-950 p-12 text-center">
          <Phone className="mx-auto h-8 w-8 text-zinc-600" />
          <p className="mt-3 text-sm text-zinc-400">Connect a WhatsApp phone and add team members to configure access.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {members.map(([memberId, member]) => (
            <section key={memberId} className="overflow-hidden rounded-xl border border-white/10 bg-zinc-950">
              <div className="border-b border-white/10 px-5 py-4">
                <div className="font-semibold text-white">{member.name}</div>
                {member.email && <div className="mt-0.5 text-xs text-zinc-500">{member.email}</div>}
              </div>
              <div className="divide-y divide-white/10">
                {member.rules.map((rule) => {
                  return (
                    <div key={rule.whatsapp_connection_id} className="grid gap-4 px-5 py-4 md:grid-cols-[1fr_auto_auto] md:items-center md:gap-8">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.04]"><Phone className="h-4 w-4 text-zinc-300" /></div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-white">{rule.instance_name || "WhatsApp phone"}</div>
                          <div className="truncate font-mono text-xs text-zinc-500">{rule.whatsapp_number}</div>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 md:min-w-40">
                        <span className="flex items-center gap-2 text-xs text-zinc-400"><Eye className="h-4 w-4" /> View</span>
                        <Toggle checked={rule.can_view_messages} disabled={savingKey !== null} label={`Allow ${member.name} to view messages from ${rule.whatsapp_number}`} onChange={() => void updateRule(rule, "can_view_messages")} />
                      </div>
                      <div className="flex items-center justify-between gap-3 md:min-w-40">
                        <span className="flex items-center gap-2 text-xs text-zinc-400"><MessageSquareText className="h-4 w-4" /> Send</span>
                        <Toggle checked={rule.can_send} disabled={savingKey !== null} label={`Allow ${member.name} to send from ${rule.whatsapp_number}`} onChange={() => void updateRule(rule, "can_send")} />
                      </div>
                      {rule.is_explicit && <div className="text-[10px] uppercase tracking-wide text-zinc-600 md:col-span-3">Custom phone rule</div>}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
