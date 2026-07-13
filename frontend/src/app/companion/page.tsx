"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";

const roleOrder = ["administrator", "manager", "sales_agent", "read_only"];

function statusBadge(status: string) {
  const value = (status || "").toLowerCase();
  if (["connected", "configured", "ready", "healthy"].includes(value)) return "badge-green";
  if (["not_connected", "not_configured", "missing"].includes(value)) return "badge-yellow";
  return "badge-blue";
}

function formatLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function formatDate(value?: string) {
  if (!value) return "—";
  try {
    return new Date(value.endsWith("Z") ? value : `${value}Z`).toLocaleString("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return value;
  }
}

function emptyMember(): api.CompanionTeamMemberInput {
  return {
    name: "",
    mobile_number: "",
    role: "sales_agent",
    assigned_markets: [],
    active: true,
    waba_identity: "",
  };
}

export default function CompanionPage() {
  const [overview, setOverview] = useState<api.CompanionOverview | null>(null);
  const [team, setTeam] = useState<api.CompanionTeamMember[]>([]);
  const [roles, setRoles] = useState<Record<string, { label: string; permissions: string[] }>>({});
  const [tools, setTools] = useState<string[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [form, setForm] = useState<api.CompanionTeamMemberInput>(emptyMember());
  const [marketsText, setMarketsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    const [nextOverview, nextTeam, nextRoles, nextTools, nextConversations, nextAudit] = await Promise.all([
      api.getCompanionOverview(),
      api.getCompanionTeam(),
      api.getCompanionRoles(),
      api.getCompanionTools(),
      api.getCompanionConversations(),
      api.getCompanionAudit(),
    ]);
    setOverview(nextOverview);
    setTeam(nextTeam);
    setRoles(nextRoles);
    setTools(nextTools.tools);
    setConversations(nextConversations);
    setAudit(nextAudit);
  }, []);

  useEffect(() => {
    load().catch((error) => setStatus(error instanceof Error ? error.message : "Unable to load Companion."));
  }, [load]);

  const overviewCards = useMemo(() => {
    if (!overview) return [];
    const wabaLabel =
      overview.waba_owner === "propai"
        ? `${overview.shared_waba_number || overview.whatsapp_business_number} (PropAI platform only)`
        : overview.whatsapp_business_number || "Not connected";
    return [
      ["Connection Status", formatLabel(overview.connection_status)],
      ["WhatsApp Business Number", wabaLabel],
      ["Connected Team Members", `${overview.connected_team_members}/${overview.total_team_members}`],
      ["Last Sync", formatDate(overview.last_sync)],
      ["Messages Today", overview.messages_today],
      ["AI Requests Today", overview.ai_requests_today],
      ["Pending Conversations", overview.pending_conversations],
      ["Outbound Messages", overview.outbound_messages],
      ["Inbound Messages", overview.inbound_messages],
      ["Webhook Health", formatLabel(overview.webhook_health)],
      ["Token Status", formatLabel(overview.token_status)],
      ["Knowledge Base Size", Object.values(overview.knowledge_base_size || {}).reduce((sum, value) => sum + Number(value || 0), 0).toLocaleString("en-IN")],
    ];
  }, [overview]);

  async function saveMember() {
    setSaving(true);
    setStatus("");
    try {
      const assigned_markets = marketsText.split(",").map((item) => item.trim()).filter(Boolean);
      await api.addCompanionTeamMember({ ...form, assigned_markets });
      setForm(emptyMember());
      setMarketsText("");
      setStatus("Team member approved for PropAI Companion.");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save team member.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleMember(member: api.CompanionTeamMember) {
    await api.updateCompanionTeamMember(member.id, {
      name: member.name,
      mobile_number: member.mobile_number,
      role: member.role,
      assigned_markets: member.assigned_markets,
      active: !member.active,
      waba_identity: member.waba_identity || "",
    });
    await load();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-white">PropAI Companion</h2>
          <div className="mt-1 text-sm text-zinc-500">
            The WhatsApp interface for your brokerage team.
          </div>
        </div>
        <span className={`badge ${statusBadge(overview?.connection_status || "")}`}>
          {overview ? formatLabel(overview.connection_status) : "Loading"}
        </span>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {overviewCards.map(([label, value]) => (
          <div key={String(label)} className="bg-zinc-900 border border-white/10 rounded-xl p-3">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</div>
            <div className="mt-1 text-lg font-bold text-white break-words">{String(value)}</div>
          </div>
        ))}
      </section>

      <section className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-bold text-white">Connection Center</h3>
            <div className="text-xs text-zinc-500 mt-1">
              Configure WhatsApp Business credentials in one place.
            </div>
          </div>
          <div className="flex gap-2">
            <span className={`badge ${overview?.waba?.has_access_token ? "badge-green" : "badge-yellow"}`}>
              Token {overview?.waba?.has_access_token ? "Saved" : "Missing"}
            </span>
            <span className={`badge ${overview?.waba?.has_verify_token ? "badge-green" : "badge-yellow"}`}>
              Webhook {overview?.waba?.has_verify_token ? "Ready" : "Not Ready"}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-black no-underline">
            Open Connection Center
          </a>
          <a href="/connections" className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white no-underline hover:bg-zinc-800">
            Copy webhook URL and tokens
          </a>
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-5">
        <section className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-bold text-white">Team</h3>
              <div className="text-xs text-zinc-500 mt-1">Only approved numbers can use PropAI over WhatsApp.</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Name"
              className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
            />
            <input
              value={form.mobile_number}
              onChange={(event) => setForm((prev) => ({ ...prev, mobile_number: event.target.value }))}
              placeholder="Mobile number"
              className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
            />
            <select
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value }))}
              className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
            >
              {roleOrder.map((role) => (
                <option key={role} value={role}>{roles[role]?.label || formatLabel(role)}</option>
              ))}
            </select>
            <input
              value={marketsText}
              onChange={(event) => setMarketsText(event.target.value)}
              placeholder="Assigned markets, comma separated"
              className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
            />
            <input
              value={form.waba_identity}
              onChange={(event) => setForm((prev) => ({ ...prev, waba_identity: event.target.value }))}
              placeholder="WABA identity"
              className="md:col-span-2 rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
            />
          </div>

          <button
            onClick={saveMember}
            disabled={saving}
            className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-black disabled:opacity-50"
          >
            {saving ? "Saving..." : "Approve Team Member"}
          </button>
          {status && <div className="mt-3 text-xs text-zinc-400">{status}</div>}

          <div className="mt-5 overflow-x-auto">
            {team.length === 0 ? (
              <div className="text-center text-sm text-zinc-500 py-8">No team members approved yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Name</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Mobile</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Role</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Markets</th>
                    <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((member) => (
                    <tr key={member.id} className="hover:bg-zinc-800">
                      <td className="px-2.5 py-2 border-b border-white/10 font-semibold">{member.name}</td>
                      <td className="px-2.5 py-2 border-b border-white/10">{member.mobile_number}</td>
                      <td className="px-2.5 py-2 border-b border-white/10">{member.role_label}</td>
                      <td className="px-2.5 py-2 border-b border-white/10">
                        {member.assigned_markets.length ? member.assigned_markets.join(", ") : "All markets"}
                      </td>
                      <td className="px-2.5 py-2 border-b border-white/10">
                        <button onClick={() => toggleMember(member)} className={`badge ${member.active ? "badge-green" : "badge-gray"}`}>
                          {member.active ? "Active" : "Paused"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="space-y-5">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
            <h3 className="text-sm font-bold text-white">AI Assistant</h3>
            <div className="mt-3 grid grid-cols-1 gap-2">
              {[
                "Show me 2 BHK Bandra under 3 Cr",
                "Any requirements for Chandak Unicorn?",
                "Find today's new listings",
                "Promote my latest listing",
                "Create a buyer requirement",
              ].map((example) => (
                <div key={example} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300">{example}</div>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
            <h3 className="text-sm font-bold text-white">Available Tools</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {tools.map((tool) => (
                <span key={tool} className="badge badge-blue">{tool}</span>
              ))}
            </div>
          </div>

          <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
            <h3 className="text-sm font-bold text-white">Permissions</h3>
            <div className="mt-3 space-y-2">
              {roleOrder.map((role) => (
                <div key={role} className="rounded-lg bg-zinc-800 px-3 py-2">
                  <div className="text-xs font-semibold text-white">{roles[role]?.label || formatLabel(role)}</div>
                  <div className="mt-1 text-[10px] text-zinc-500">
                    {(roles[role]?.permissions || []).map(formatLabel).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <section className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
          <h3 className="text-sm font-bold text-white">Human Handoff</h3>
          {conversations.length === 0 ? (
            <div className="text-sm text-zinc-500 py-8 text-center">No active Companion conversations.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {conversations.map((conversation) => (
                <div key={conversation.id} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-white">{conversation.team_member_name || conversation.mobile_number}</span>
                    <span className={`badge ${statusBadge(conversation.status)}`}>{formatLabel(conversation.status)}</span>
                  </div>
                  <div className="mt-1 text-zinc-500">{formatDate(conversation.last_message_at || conversation.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
          <h3 className="text-sm font-bold text-white">Audit Log</h3>
          {audit.length === 0 ? (
            <div className="text-sm text-zinc-500 py-8 text-center">No Companion activity logged yet.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {audit.map((item) => (
                <div key={item.id} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-white">{formatLabel(item.action)}</span>
                    <span className="text-zinc-500">{formatDate(item.created_at)}</span>
                  </div>
                  <div className="mt-1 text-zinc-400">{item.team_member_name || "System"} · {formatLabel(item.status)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
