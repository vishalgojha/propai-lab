"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import * as api from "@/lib/api";

interface Dashboard {
  whatsapp_session: string;
  webhook_status: string;
  groups_discovered: number;
  groups_monitored: number;
  total_groups: number;
  live_groups: number;
  msgs_today: number;
  last_webhook: string;
  webhook_healthy: boolean;
  error_groups: number;
  duplicate_groups: number;
  attention_required: number;
  attention_breakdown: {
    inactive: number;
    duplicate: number;
    unnamed: number;
    error: number;
  };
  inactive_groups: number;
  unnamed_groups: number;
  failed_events: number;
  pending_enrichment: number;
  pending_ai_suggestions: number;
  avg_process_secs: number | null;
  msgs_per_min: number;
  parser_success_rate: number;
  queue_backlog: number;
}

interface TimelineEvent {
  source: string;
  ts: string;
  subtype: string;
  label: string;
  group_name?: string;
  ref?: number;
}

interface GroupCard {
  jid: string;
  name: string;
  status: string;
  health: string;
  error: string;
  messages: number;
  last_activity: string;
  observations: number;
  listings: number;
  requirements: number;
  markets_count: number;
  unknown_locations: number;
  coverage: number;
  active_brokers: number;
  duplicate_pct: number;
  parsed: { city?: string; area?: string };
}

interface TopContributor {
  group_name: string;
  msg_count: number;
  unique_senders: number;
  last_msg: string;
}

interface CaptureHealth {
  msgs_per_min: number;
  avg_process_secs: number | null;
  parser_success_rate: number;
  last_webhook: string;
  queue_backlog: number;
  pending_enrichment: number;
  pending_ai_suggestions: number;
  total_msgs_today: number;
  total_parsed_today: number;
}

function HealthCard({ label, value, good, bad, neutral, detail, icon }: {
  label: string; value: string | number; good?: boolean; bad?: boolean; neutral?: boolean; detail?: string; icon?: string;
}) {
  const color = good ? "text-green-400" : bad ? "text-red-400" : neutral ? "text-yellow-400" : "text-white";
  const bg = good ? "bg-green-500/10 border-green-500/20" : bad ? "bg-red-500/10 border-red-500/20" : neutral ? "bg-yellow-500/10 border-yellow-500/20" : "bg-[#0d1117] border-[rgba(255,255,255,0.06)]";
  return (
    <div className={`rounded-xl border p-3 ${bg}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider">{label}</span>
        {icon && <span className="text-xs">{icon}</span>}
      </div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      {detail && <div className="text-[10px] text-[#64748b] mt-0.5">{detail}</div>}
    </div>
  );
}

function StatusBadge({ status, health }: { status: string; health: string }) {
  const colors: Record<string, string> = {
    live: "text-green-400 bg-green-500/10",
    error: "text-red-400 bg-red-500/10",
    inactive: "text-yellow-400 bg-yellow-500/10",
  };
  const healthColors: Record<string, string> = {
    healthy: "text-green-400 bg-green-500/10",
    degraded: "text-yellow-400 bg-yellow-500/10",
    unhealthy: "text-red-400 bg-red-500/10",
    stale: "text-[#94a3b8] bg-[rgba(255,255,255,0.04)]",
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${colors[status] || colors.inactive}`}>
        {status.toUpperCase()}
      </span>
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${healthColors[health] || healthColors.stale}`}>
        {health.toUpperCase()}
      </span>
    </div>
  );
}

function shortJid(jid: string) {
  return jid.split("@")[0].slice(-8);
}

function timeAgo(ts: string) {
  if (!ts || ts === "never") return "never";
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function QuickFilter({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button onClick={onClick}
      className={`text-[10px] font-semibold px-2 py-1 rounded-lg capitalize transition-colors ${
        active ? "bg-blue-600 text-white" : "text-[#94a3b8] border border-[rgba(255,255,255,0.08)] hover:text-white"
      }`}
    >
      {label} {count != null && <span className="ml-1 px-1.5 py-0.5 text-[9px] rounded bg-white/10">{count}</span>}
    </button>
  );
}

export default function AuditPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [groups, setGroups] = useState<GroupCard[]>([]);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealth | null>(null);
  const [topContributors, setTopContributors] = useState<TopContributor[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"explorer" | "duplicates" | "health">("explorer");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, tl, grps, health, top] = await Promise.all([
        api.getAuditDashboard(),
        api.getAuditTimeline(50),
        api.getAuditGroups(),
        api.getAuditCaptureHealth(),
        api.getAuditTopContributors(8),
      ]);
      setDashboard(dash);
      setTimeline(tl);
      setGroups(grps);
      setCaptureHealth(health);
      setTopContributors(top);
    } catch (e) {
      console.error("Audit load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredGroups = useMemo(() => {
    return groups.filter((g) => {
      if (groupFilter && g.status !== groupFilter) return false;
      if (groupSearch) {
        const q = groupSearch.toLowerCase();
        if (!g.name.toLowerCase().includes(q) && !g.jid.includes(q)) return false;
      }
      return true;
    });
  }, [groups, groupSearch, groupFilter]);

  if (loading && !dashboard) {
    return <div className="text-center text-[#64748b] py-16">Loading...</div>;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* ─── Section: Connection Status Header ─── */}
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <HealthCard
            label="WhatsApp Session"
            value={dashboard.whatsapp_session === "connected" ? "Connected" : "Disconnected"}
            good={dashboard.whatsapp_session === "connected"}
            bad={dashboard.whatsapp_session !== "connected"}
            icon="📱"
          />
          <HealthCard
            label="Webhook"
            value={dashboard.webhook_status === "live" ? "Live" : "Offline"}
            good={dashboard.webhook_status === "live"}
            bad={dashboard.webhook_status !== "live"}
            icon="🔗"
          />
          <HealthCard
            label="Groups Discovered"
            value={dashboard.groups_discovered}
            detail={dashboard.groups_monitored > 0 ? `${dashboard.groups_monitored} monitored` : ""}
            icon="📋"
          />
          <HealthCard
            label="Messages Today"
            value={dashboard.msgs_today.toLocaleString()}
            detail={`${dashboard.msgs_per_min}/min`}
            icon="💬"
          />
        </div>
      )}

      {/* ─── Section: Attention Required ─── */}
      {dashboard && dashboard.attention_required > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-red-400">⚠️</span>
            <span className="text-sm font-semibold text-red-300">
              {dashboard.attention_required} groups need review
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <div className="bg-red-500/5 p-2 rounded-lg">
              <div className="text-[10px] text-[#64748b]">Inactive (24h)</div>
              <div className="font-bold text-red-300">{dashboard.attention_breakdown.inactive}</div>
            </div>
            <div className="bg-yellow-500/5 p-2 rounded-lg">
              <div className="text-[10px] text-[#64748b]">Duplicate names</div>
              <div className="font-bold text-yellow-300">{dashboard.attention_breakdown.duplicate}</div>
            </div>
            <div className="bg-blue-500/5 p-2 rounded-lg">
              <div className="text-[10px] text-[#64748b]">Unnamed</div>
              <div className="font-bold text-blue-300">{dashboard.attention_breakdown.unnamed}</div>
            </div>
            <div className="bg-red-500/5 p-2 rounded-lg">
              <div className="text-[10px] text-[#64748b]">Errors</div>
              <div className="font-bold text-red-300">{dashboard.attention_breakdown.error}</div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Section: Timeline + Capture Health ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Timeline */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Health Timeline</h2>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 max-h-96 overflow-y-auto">
            {timeline.length === 0 ? (
              <div className="text-xs text-[#64748b] py-8 text-center">No events yet</div>
            ) : (
              <div className="space-y-0">
                {timeline.map((ev, i) => {
                  const sourceIcons: Record<string, string> = {
                    webhook: "📩",
                    group: "👥",
                    duplicate: "⚠️",
                    enrichment: "⚙️",
                    suggestion: "🤖",
                    system: "🔄",
                  };
                  const dotColors: Record<string, string> = {
                    webhook: "bg-blue-500",
                    group: "bg-emerald-500",
                    duplicate: "bg-yellow-500",
                    enrichment: "bg-yellow-500",
                    suggestion: "bg-violet-500",
                    system: "bg-orange-500",
                  };
                  return (
                    <div key={i} className="flex gap-3 py-2 border-b border-[rgba(255,255,255,0.03)] last:border-0">
                      <div className="flex flex-col items-center">
                        <div className={`w-2 h-2 rounded-full ${dotColors[ev.source] || "bg-white"} mt-1.5`} />
                        {i < timeline.length - 1 && <div className="w-px flex-1 bg-[rgba(255,255,255,0.05)]" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-[#64748b] font-mono">
                            {new Date(ev.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className="text-xs text-white">{sourceIcons[ev.source] || ""}</span>
                          <span className="text-xs text-white">{ev.label || ev.source}</span>
                        </div>
                        {ev.group_name && <div className="text-[10px] text-[#64748b]">{ev.group_name}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Capture Health */}
        <div>
          <h2 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Capture Health</h2>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 space-y-3">
            {captureHealth ? (
              <>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Messages/min</span>
                  <span className="font-medium text-white">{captureHealth.msgs_per_min}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Avg Processing</span>
                  <span className="font-mono text-[11px] text-white">{captureHealth.avg_process_secs != null ? `${captureHealth.avg_process_secs}s` : "—"}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Parser Success</span>
                  <span className={captureHealth.parser_success_rate > 80 ? "text-green-400" : captureHealth.parser_success_rate > 50 ? "text-yellow-400" : "text-red-400"}>
                    {captureHealth.parser_success_rate}%
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Last Webhook</span>
                  <span className="font-mono text-[11px] text-white">{timeAgo(captureHealth.last_webhook)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Queue Backlog</span>
                  <span className={captureHealth.queue_backlog > 50 ? "text-red-400" : captureHealth.queue_backlog > 10 ? "text-yellow-400" : "text-green-400"}>
                    {captureHealth.queue_backlog}
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs pt-2 border-t border-[rgba(255,255,255,0.03)]">
                  <span className="text-[#94a3b8]">Today</span>
                  <span className="text-white">{captureHealth.total_msgs_today.toLocaleString()} msgs / {captureHealth.total_parsed_today.toLocaleString()} parsed</span>
                </div>
              </>
            ) : (
              <div className="text-xs text-[#64748b] text-center py-4">Loading...</div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Section: Top Contributors Today ─── */}
      {topContributors.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Top Contributors Today</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {topContributors.map((g, i) => (
              <div key={g.group_name} className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] text-[#64748b] font-mono">#{i + 1}</span>
                  <span className="text-sm font-semibold truncate">{g.group_name}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] text-[#64748b]">Messages</div>
                    <div className="font-semibold text-white">{g.msg_count.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Senders</div>
                    <div className="font-semibold text-white">{g.unique_senders}</div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-[10px] text-[#64748b]">Last msg</div>
                    <div className="font-semibold text-white">{timeAgo(g.last_msg)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── Section: Tabs ─── */}
      <div className="flex gap-1 text-xs border-b border-[rgba(255,255,255,0.06)] pb-2">
        {(["explorer", "duplicates", "health"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-lg font-medium capitalize ${
              activeTab === tab ? "bg-blue-600 text-white" : "text-[#94a3b8] hover:text-white"
            }`}
          >
            {tab === "explorer" ? "Group Explorer" : tab === "duplicates" ? "Duplicate Groups" : "System Health"}
          </button>
        ))}
      </div>

      {/* ─── Tab: Group Explorer ─── */}
      {activeTab === "explorer" && (
        <div>
          <div className="flex gap-2 mb-4 flex-wrap items-center">
            <input
              type="text" value={groupSearch} onChange={(e) => setGroupSearch(e.target.value)}
              placeholder="Search groups by name or JID..."
              className="flex-1 min-w-[200px] bg-[#0d1117] border border-[rgba(255,255,255,0.08)] rounded-lg px-3 py-1.5 text-xs text-white placeholder-[#64748b]"
            />
            <div className="flex gap-1 flex-wrap">
              <QuickFilter label="All" active={!groupFilter} onClick={() => setGroupFilter("")} count={filteredGroups.length} />
              <QuickFilter label="Healthy" active={groupFilter === "live"} onClick={() => setGroupFilter("live")} count={filteredGroups.filter(g => g.health === "healthy").length} />
              <QuickFilter label="Degraded" active={groupFilter === "degraded"} onClick={() => setGroupFilter("degraded")} count={filteredGroups.filter(g => g.health === "degraded").length} />
              <QuickFilter label="Inactive" active={groupFilter === "inactive"} onClick={() => setGroupFilter("inactive")} count={filteredGroups.filter(g => g.status === "inactive").length} />
              <QuickFilter label="Errors" active={groupFilter === "error"} onClick={() => setGroupFilter("error")} count={filteredGroups.filter(g => g.status === "error").length} />
              <QuickFilter label="High Dups" active={groupFilter === "high-dup"} onClick={() => setGroupFilter("high-dup")} count={filteredGroups.filter(g => g.duplicate_pct > 20).length} />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredGroups.slice(0, 60).map((g) => (
              <a key={g.jid} href={`/audit/groups/${encodeURIComponent(g.jid)}`}
                className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 hover:border-blue-500/30 transition-all block group"
              >
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-semibold truncate flex-1 pr-2">{g.name}</h3>
                  <StatusBadge status={g.status} health={g.health} />
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2 text-xs">
                  <div>
                    <div className="text-[10px] text-[#64748b]">Messages</div>
                    <div className="font-semibold text-white">{g.messages.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Listings</div>
                    <div className="font-semibold text-white">{g.listings}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Requirements</div>
                    <div className="font-semibold text-white">{g.requirements}</div>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2 text-xs">
                  <div>
                    <div className="text-[10px] text-[#64748b]">Active Brokers</div>
                    <div className="font-semibold text-white">{g.active_brokers}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Duplicates</div>
                    <div className={`font-semibold ${g.duplicate_pct > 20 ? "text-red-400" : g.duplicate_pct > 10 ? "text-yellow-400" : "text-white"}`}>{g.duplicate_pct}%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Markets</div>
                    <div className="font-semibold text-white">{g.markets_count}</div>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-[#64748b]">Last: {timeAgo(g.last_activity)}</span>
                  <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                    Inspect →
                  </span>
                </div>
              </a>
            ))}
          </div>
          {filteredGroups.length > 60 && (
            <div className="text-center text-[10px] text-[#64748b] mt-3">
              Showing 60 of {filteredGroups.length} groups (use filters to narrow)
            </div>
          )}
        </div>
      )}

      {/* ─── Tab: Duplicate Groups ─── */}
      {activeTab === "duplicates" && (
        <div>
          <div className="mb-4">
            <h2 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Duplicate Groups</h2>
            <p className="text-xs text-[#64748b]">Groups with identical display names — merge metadata or ignore</p>
          </div>
          <div className="space-y-3">
            {groups.filter(g => g.health === "degraded" || g.duplicate_pct > 10).length === 0 ? (
              <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-8 text-center">
                <div className="text-2xl mb-2">✅</div>
                <div className="text-sm font-semibold text-green-400">No duplicate groups detected</div>
                <div className="text-xs text-[#64748b] mt-1">All groups have unique names</div>
              </div>
            ) : (
              groups.filter(g => g.duplicate_pct > 10 || g.status === "error").map((g, i) => (
                <div key={i} className="bg-[#0d1117] border border-yellow-500/20 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{g.name}</div>
                      <div className="text-[10px] text-[#64748b] font-mono">{shortJid(g.jid)}</div>
                    </div>
                    <div className="text-[10px] text-yellow-400 bg-yellow-500/10 px-2 py-1 rounded">
                      {g.duplicate_pct}% duplicate observations
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button className="px-3 py-1 text-[10px] font-medium bg-blue-600 hover:bg-blue-500 rounded-lg">
                      Merge Metadata
                    </button>
                    <button className="px-3 py-1 text-[10px] font-medium text-[#64748b] border border-[rgba(255,255,255,0.1)] hover:text-white rounded-lg">
                      Ignore
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ─── Tab: System Health ─── */}
      {activeTab === "health" && captureHealth && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <HealthCard
            label="Messages/min"
            value={captureHealth.msgs_per_min}
            icon="📊"
          />
          <HealthCard
            label="Avg Process Time"
            value={captureHealth.avg_process_secs != null ? `${captureHealth.avg_process_secs}s` : "—"}
            icon="⏱️"
          />
          <HealthCard
            label="Parser Success"
            value={`${captureHealth.parser_success_rate}%`}
            good={captureHealth.parser_success_rate > 80}
            neutral={captureHealth.parser_success_rate > 50 && captureHealth.parser_success_rate <= 80}
            bad={captureHealth.parser_success_rate <= 50}
            icon="✅"
          />
          <HealthCard
            label="Queue Backlog"
            value={captureHealth.queue_backlog}
            good={captureHealth.queue_backlog <= 10}
            neutral={captureHealth.queue_backlog <= 50}
            bad={captureHealth.queue_backlog > 50}
            icon="📦"
          />
          <HealthCard
            label="Pending Enrichment"
            value={captureHealth.pending_enrichment}
            neutral={captureHealth.pending_enrichment > 0}
            icon="⚙️"
          />
          <HealthCard
            label="Pending AI Suggestions"
            value={captureHealth.pending_ai_suggestions}
            neutral={captureHealth.pending_ai_suggestions > 0}
            icon="🤖"
          />
          <HealthCard
            label="Total Messages Today"
            value={captureHealth.total_msgs_today.toLocaleString()}
            detail={`${captureHealth.total_parsed_today.toLocaleString()} parsed`}
            icon="💬"
          />
          <HealthCard
            label="Last Webhook"
            value={timeAgo(captureHealth.last_webhook)}
            icon="🔗"
          />
        </div>
      )}
    </div>
  );
}