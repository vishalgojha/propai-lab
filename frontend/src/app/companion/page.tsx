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
  const [config, setConfig] = useState<api.CompanionConfig | null>(null);
  const [team, setTeam] = useState<api.CompanionTeamMember[]>([]);
  const [roles, setRoles] = useState<Record<string, { label: string; permissions: string[] }>>({});
  const [tools, setTools] = useState<string[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [form, setForm] = useState<api.CompanionTeamMemberInput>(emptyMember());
  const [marketsText, setMarketsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [configStatus, setConfigStatus] = useState("");
  const [configSaving, setConfigSaving] = useState(false);
  const [configForm, setConfigForm] = useState({
    whatsapp_business_number: "",
    phone_number_id: "",
    access_token: "",
    verify_token: "",
  });

  const load = useCallback(async () => {
    const [nextOverview, nextConfig, nextTeam, nextRoles, nextTools, nextConversations, nextAudit] = await Promise.all([
      api.getCompanionOverview(),
      api.getCompanionConfig(),
      api.getCompanionTeam(),
      api.getCompanionRoles(),
      api.getCompanionTools(),
      api.getCompanionConversations(),
      api.getCompanionAudit(),
    ]);
    setOverview(nextOverview);
    setConfig(nextConfig);
    setConfigForm((prev) => ({
      ...prev,
      whatsapp_business_number: nextConfig.whatsapp_business_number || "",
      phone_number_id: nextConfig.phone_number_id || "",
      access_token: "",
      verify_token: "",
    }));
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
    return [
      ["Connection Status", formatLabel(overview.connection_status)],
      ["WhatsApp Business Number", overview.whatsapp_business_number || "Not connected"],
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

  async function saveWabaConfig() {
    setConfigSaving(true);
    setConfigStatus("");
    try {
      const nextConfig = await api.saveCompanionConfig({
        whatsapp_business_number: configForm.whatsapp_business_number.trim(),
        phone_number_id: configForm.phone_number_id.trim(),
        access_token: configForm.access_token.trim(),
        verify_token: configForm.verify_token.trim(),
      });
      setConfig(nextConfig);
      setConfigForm((prev) => ({ ...prev, access_token: "", verify_token: "" }));
      setConfigStatus("WABA credentials saved.");
      await load();
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Could not save WABA credentials.");
    } finally {
      setConfigSaving(false);
    }
  }

  async function clearSecret(kind: "access_token" | "verify_token") {
    setConfigSaving(true);
    setConfigStatus("");
    try {
      const nextConfig = await api.saveCompanionConfig({
        clear_access_token: kind === "access_token",
        clear_verify_token: kind === "verify_token",
      });
      setConfig(nextConfig);
      setConfigStatus(kind === "access_token" ? "Access token cleared." : "Verify token cleared.");
      await load();
    } catch (error) {
      setConfigStatus(error instanceof Error ? error.message : "Could not update WABA credentials.");
    } finally {
      setConfigSaving(false);
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
          <h2 className="text-lg font-bold text-[#e2e8f0]">PropAI Companion</h2>
          <div className="mt-1 text-sm text-[#64748b]">
            The WhatsApp interface for your brokerage team.
          </div>
        </div>
        <span className={`badge ${statusBadge(overview?.connection_status || "")}`}>
          {overview ? formatLabel(overview.connection_status) : "Loading"}
        </span>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {overviewCards.map(([label, value]) => (
          <div key={String(label)} className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider">{label}</div>
            <div className="mt-1 text-lg font-bold text-[#e2e8f0] break-words">{String(value)}</div>
          </div>
        ))}
      </section>

      <section className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-bold text-[#e2e8f0]">WhatsApp Business Setup</h3>
            <div className="text-xs text-[#64748b] mt-1">
              Connect the official WhatsApp Business number your team will message.
            </div>
          </div>
          <div className="flex gap-2">
            <span className={`badge ${config?.has_access_token ? "badge-green" : "badge-yellow"}`}>
              Token {config?.has_access_token ? "Saved" : "Missing"}
            </span>
            <span className={`badge ${config?.has_verify_token ? "badge-green" : "badge-yellow"}`}>
              Webhook {config?.has_verify_token ? "Ready" : "Not Ready"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[10px] text-[#64748b] uppercase tracking-wider">WhatsApp Business Number</span>
            <input
              value={configForm.whatsapp_business_number}
              onChange={(event) => setConfigForm((prev) => ({ ...prev, whatsapp_business_number: event.target.value }))}
              placeholder="+91..."
              className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-[#64748b] uppercase tracking-wider">Phone Number ID</span>
            <input
              value={configForm.phone_number_id}
              onChange={(event) => setConfigForm((prev) => ({ ...prev, phone_number_id: event.target.value }))}
              placeholder="Meta phone number ID"
              className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-[#64748b] uppercase tracking-wider">
              Access Token {config?.access_token_preview ? `(${config.access_token_preview})` : ""}
            </span>
            <input
              type="password"
              value={configForm.access_token}
              onChange={(event) => setConfigForm((prev) => ({ ...prev, access_token: event.target.value }))}
              placeholder={config?.has_access_token ? "Paste a new token to replace" : "Paste Meta access token"}
              className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] text-[#64748b] uppercase tracking-wider">
              Verify Token {config?.verify_token_preview ? `(${config.verify_token_preview})` : ""}
            </span>
            <input
              type="password"
              value={configForm.verify_token}
              onChange={(event) => setConfigForm((prev) => ({ ...prev, verify_token: event.target.value }))}
              placeholder={config?.has_verify_token ? "Paste a new token to replace" : "Create a webhook verify token"}
              className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={saveWabaConfig}
            disabled={configSaving}
            className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] disabled:opacity-50"
          >
            {configSaving ? "Saving..." : "Save WABA Credentials"}
          </button>
          {config?.has_access_token && (
            <button onClick={() => clearSecret("access_token")} className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] hover:bg-[#111820]">
              Clear Access Token
            </button>
          )}
          {config?.has_verify_token && (
            <button onClick={() => clearSecret("verify_token")} className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] hover:bg-[#111820]">
              Clear Verify Token
            </button>
          )}
        </div>
        {configStatus && <div className="mt-3 text-xs text-[#94a3b8]">{configStatus}</div>}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-5">
        <section className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-bold text-[#e2e8f0]">Team</h3>
              <div className="text-xs text-[#64748b] mt-1">Only approved numbers can use PropAI over WhatsApp.</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Name"
              className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
            <input
              value={form.mobile_number}
              onChange={(event) => setForm((prev) => ({ ...prev, mobile_number: event.target.value }))}
              placeholder="Mobile number"
              className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
            <select
              value={form.role}
              onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value }))}
              className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            >
              {roleOrder.map((role) => (
                <option key={role} value={role}>{roles[role]?.label || formatLabel(role)}</option>
              ))}
            </select>
            <input
              value={marketsText}
              onChange={(event) => setMarketsText(event.target.value)}
              placeholder="Assigned markets, comma separated"
              className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
            <input
              value={form.waba_identity}
              onChange={(event) => setForm((prev) => ({ ...prev, waba_identity: event.target.value }))}
              placeholder="WABA identity"
              className="md:col-span-2 rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
            />
          </div>

          <button
            onClick={saveMember}
            disabled={saving}
            className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] disabled:opacity-50"
          >
            {saving ? "Saving..." : "Approve Team Member"}
          </button>
          {status && <div className="mt-3 text-xs text-[#94a3b8]">{status}</div>}

          <div className="mt-5 overflow-x-auto">
            {team.length === 0 ? (
              <div className="text-center text-sm text-[#64748b] py-8">No team members approved yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Name</th>
                    <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Mobile</th>
                    <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Role</th>
                    <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Markets</th>
                    <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((member) => (
                    <tr key={member.id} className="hover:bg-[#111820]">
                      <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">{member.name}</td>
                      <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{member.mobile_number}</td>
                      <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{member.role_label}</td>
                      <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                        {member.assigned_markets.length ? member.assigned_markets.join(", ") : "All markets"}
                      </td>
                      <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
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
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
            <h3 className="text-sm font-bold text-[#e2e8f0]">AI Assistant</h3>
            <div className="mt-3 grid grid-cols-1 gap-2">
              {[
                "Show me 2 BHK Bandra under 3 Cr",
                "Any buyers for Chandak Unicorn?",
                "Find today's new listings",
                "Promote my latest listing",
                "Create a buyer requirement",
              ].map((example) => (
                <div key={example} className="rounded-lg bg-[#111820] px-3 py-2 text-xs text-[#cbd5e1]">{example}</div>
              ))}
            </div>
          </div>

          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
            <h3 className="text-sm font-bold text-[#e2e8f0]">Available Tools</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {tools.map((tool) => (
                <span key={tool} className="badge badge-blue">{tool}</span>
              ))}
            </div>
          </div>

          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
            <h3 className="text-sm font-bold text-[#e2e8f0]">Permissions</h3>
            <div className="mt-3 space-y-2">
              {roleOrder.map((role) => (
                <div key={role} className="rounded-lg bg-[#111820] px-3 py-2">
                  <div className="text-xs font-semibold text-[#e2e8f0]">{roles[role]?.label || formatLabel(role)}</div>
                  <div className="mt-1 text-[10px] text-[#64748b]">
                    {(roles[role]?.permissions || []).map(formatLabel).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <section className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <h3 className="text-sm font-bold text-[#e2e8f0]">Human Handoff</h3>
          {conversations.length === 0 ? (
            <div className="text-sm text-[#64748b] py-8 text-center">No active Companion conversations.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {conversations.map((conversation) => (
                <div key={conversation.id} className="rounded-lg bg-[#111820] px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-[#e2e8f0]">{conversation.team_member_name || conversation.mobile_number}</span>
                    <span className={`badge ${statusBadge(conversation.status)}`}>{formatLabel(conversation.status)}</span>
                  </div>
                  <div className="mt-1 text-[#64748b]">{formatDate(conversation.last_message_at || conversation.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <h3 className="text-sm font-bold text-[#e2e8f0]">Audit Log</h3>
          {audit.length === 0 ? (
            <div className="text-sm text-[#64748b] py-8 text-center">No Companion activity logged yet.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {audit.map((item) => (
                <div key={item.id} className="rounded-lg bg-[#111820] px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold text-[#e2e8f0]">{formatLabel(item.action)}</span>
                    <span className="text-[#64748b]">{formatDate(item.created_at)}</span>
                  </div>
                  <div className="mt-1 text-[#94a3b8]">{item.team_member_name || "System"} · {formatLabel(item.status)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
