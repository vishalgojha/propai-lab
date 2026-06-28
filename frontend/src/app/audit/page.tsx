"use client";

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";

interface Dashboard {
  total_groups: number;
  live_groups: number;
  msgs_today: number;
  last_webhook: string;
  webhook_healthy: boolean;
  error_groups: number;
  duplicate_groups: number;
  attention_required: number;
  inactive_groups: number;
  failed_events: number;
  pending_enrichment: number;
  pending_ai_suggestions: number;
  avg_process_secs: number | null;
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
  error: string;
  messages: number;
  last_activity: string;
  observations: number;
  listings: number;
  requirements: number;
  markets_count: number;
  unknown_locations: number;
  coverage: number;
}

interface CaptureHealth {
  webhook_healthy: boolean;
  last_message: string;
  msgs_last_hour: number;
  avg_process_secs: number | null;
  pending_enrichment: number;
  failed_enrichment: number;
  retry_count: number;
  parser_success_rate: number;
  total_msgs_today: number;
  total_parsed_today: number;
}

interface GroupDupe {
  group_a: { jid: string; name: string };
  group_b: { jid: string; name: string };
  match_type: string;
}

function HealthCard({ label, value, good, bad, neutral, detail }: {
  label: string; value: string | number; good?: boolean; bad?: boolean; neutral?: boolean; detail?: string;
}) {
  const color = good ? "text-green-400" : bad ? "text-red-400" : neutral ? "text-yellow-400" : "text-white";
  const bg = good ? "bg-green-500/10 border-green-500/20" : bad ? "bg-red-500/10 border-red-500/20" : neutral ? "bg-yellow-500/10 border-yellow-500/20" : "bg-[#0d1117] border-[rgba(255,255,255,0.06)]";
  return (
    <div className={`rounded-xl border p-3 ${bg}`}>
      <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      {detail && <div className="text-[10px] text-[#64748b] mt-0.5">{detail}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    live: "text-green-400 bg-green-500/10",
    error: "text-red-400 bg-red-500/10",
    inactive: "text-yellow-400 bg-yellow-500/10",
    paused: "text-[#94a3b8] bg-[rgba(255,255,255,0.04)]",
  };
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${colors[status] || colors.inactive}`}>
      {status.toUpperCase()}
    </span>
  );
}

function shortJid(jid: string) {
  return jid.split("@")[0].slice(-8);
}

function timeAgo(ts: string) {
  if (!ts) return "never";
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function AuditPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [groups, setGroups] = useState<GroupCard[]>([]);
  const [captureHealth, setCaptureHealth] = useState<CaptureHealth | null>(null);
  const [duplicates, setDuplicates] = useState<GroupDupe[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [activeTab, setActiveTab] = useState<"explorer" | "duplicates" | "health">("explorer");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, tl, grps, health, dup] = await Promise.all([
        api.getAuditDashboard(),
        api.getAuditTimeline(20),
        api.getAuditGroups(),
        api.getAuditCaptureHealth(),
        api.getAuditDuplicates(),
      ]);
      setDashboard(dash);
      setTimeline(tl);
      setGroups(grps);
      setCaptureHealth(health);
      setDuplicates(dup);
    } catch (e) {
      console.error("Audit load failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredGroups = groups.filter((g) => {
    if (groupFilter && g.status !== groupFilter) return false;
    if (groupSearch) {
      const q = groupSearch.toLowerCase();
      if (!g.name.toLowerCase().includes(q) && !g.jid.includes(q)) return false;
    }
    return true;
  });

  if (loading && !dashboard) {
    return <div className="text-center text-[#64748b] py-16">Loading...</div>;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* ─── Section: Operational Health Cards ─── */}
      {dashboard && (
        <div>
          <h2 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Operational Health</h2>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <HealthCard label="Connected Groups" value={dashboard.total_groups} detail={`${dashboard.live_groups} live`} />
            <HealthCard label="Live Capture" value={dashboard.webhook_healthy ? "Healthy" : "Inactive"} good={dashboard.webhook_healthy} bad={!dashboard.webhook_healthy} />
            <HealthCard label="Last Event" value={timeAgo(dashboard.last_webhook)} neutral detail={dashboard.last_webhook !== "never" ? new Date(dashboard.last_webhook).toLocaleTimeString("en-IN") : ""} />
            <HealthCard label="Messages Today" value={dashboard.msgs_today.toLocaleString()} />
            <HealthCard label="Groups With Errors" value={dashboard.error_groups} good={dashboard.error_groups === 0} bad={dashboard.error_groups > 0} />
            <HealthCard label="Duplicate Groups" value={dashboard.duplicate_groups} neutral={dashboard.duplicate_groups > 0} good={dashboard.duplicate_groups === 0} />
            <HealthCard label="Inactive Groups" value={dashboard.inactive_groups} neutral={dashboard.inactive_groups > 0} />
            <HealthCard label="Attention Required" value={dashboard.attention_required} bad={dashboard.attention_required > 0} good={dashboard.attention_required === 0} />
          </div>
        </div>
      )}

      {/* ─── Section: Timeline + Capture Health ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Timeline */}
        <div className="lg:col-span-2">
          <h2 className="text-sm font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Health Timeline</h2>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 max-h-80 overflow-y-auto">
            {timeline.length === 0 ? (
              <div className="text-xs text-[#64748b] py-8 text-center">No events yet</div>
            ) : (
              <div className="space-y-0">
                {timeline.map((ev, i) => {
                  const icon = ev.source === "webhook" ? "📩" : ev.source === "enrichment" ? "⚙️" : ev.source === "suggestion" ? "🤖" : "📊";
                  const dotColor = ev.source === "webhook" ? "bg-blue-500" : ev.source === "enrichment" ? "bg-yellow-500" : "bg-violet-500";
                  return (
                    <div key={i} className="flex gap-3 py-2 border-b border-[rgba(255,255,255,0.03)] last:border-0">
                      <div className="flex flex-col items-center">
                        <div className={`w-2 h-2 rounded-full ${dotColor} mt-1.5`} />
                        {i < timeline.length - 1 && <div className="w-px flex-1 bg-[rgba(255,255,255,0.05)]" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-[#64748b] font-mono">
                            {new Date(ev.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <span className="text-xs">{ev.label || ev.source}</span>
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
                  <span className="text-[#94a3b8]">Webhook</span>
                  <span className={`font-medium ${captureHealth.webhook_healthy ? "text-green-400" : "text-red-400"}`}>
                    {captureHealth.webhook_healthy ? "Healthy" : "Down"}
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Last Message</span>
                  <span className="font-mono text-[11px] text-white">{timeAgo(captureHealth.last_message)}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Msgs / Hour</span>
                  <span className="text-white">{captureHealth.msgs_last_hour}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Avg Process</span>
                  <span className="text-white">{captureHealth.avg_process_secs != null ? `${captureHealth.avg_process_secs}s` : "—"}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Parser Success</span>
                  <span className={captureHealth.parser_success_rate > 80 ? "text-green-400" : "text-yellow-400"}>
                    {captureHealth.parser_success_rate}%
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Parser Queue</span>
                  <span className="text-white">{captureHealth.pending_enrichment}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Failed Events</span>
                  <span className={captureHealth.failed_enrichment > 0 ? "text-red-400" : "text-green-400"}>
                    {captureHealth.failed_enrichment}
                  </span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-[#94a3b8]">Retry Count</span>
                  <span className="text-white">{captureHealth.retry_count}</span>
                </div>
              </>
            ) : (
              <div className="text-xs text-[#64748b] text-center py-4">Loading...</div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Section: Tabs ─── */}
      <div className="flex gap-1 text-xs border-b border-[rgba(255,255,255,0.06)] pb-2">
        {(["explorer", "duplicates", "health"] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 rounded-lg font-medium capitalize ${
              activeTab === tab ? "bg-blue-600 text-white" : "text-[#94a3b8] hover:text-white"
            }`}
          >
            {tab === "explorer" ? "Group Explorer" : tab === "duplicates" ? "Duplicate Groups" : "Full Diagnostics"}
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
            {["", "live", "inactive", "error"].map((s) => (
              <button key={s} onClick={() => setGroupFilter(s)}
                className={`text-xs px-2.5 py-1.5 rounded-lg font-medium capitalize ${
                  groupFilter === s ? "bg-blue-600 text-white" : "text-[#94a3b8] border border-[rgba(255,255,255,0.08)] hover:text-white"
                }`}
              >
                {s || "All"}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filteredGroups.slice(0, 60).map((g) => (
              <a key={g.jid} href={`/audit/groups/${encodeURIComponent(g.jid)}`}
                className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 hover:border-blue-500/30 transition-all block group"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold truncate flex-1">{g.name}</h3>
                  <StatusBadge status={g.status} />
                </div>
                <div className="grid grid-cols-3 gap-2 mb-2">
                  <div>
                    <div className="text-[10px] text-[#64748b]">Messages</div>
                    <div className="text-xs font-semibold">{g.messages.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Listings</div>
                    <div className="text-xs font-semibold">{g.listings}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#64748b]">Markets</div>
                    <div className="text-xs font-semibold">{g.markets_count}</div>
                  </div>
                </div>
                {/* Coverage bar */}
                <div className="mb-2">
                  <div className="flex justify-between text-[10px] text-[#64748b] mb-0.5">
                    <span>Coverage</span>
                    <span>{g.coverage}%</span>
                  </div>
                  <div className="h-1.5 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
                    <div className="h-full rounded-full bg-blue-500" style={{ width: `${g.coverage}%` }} />
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
          {duplicates.length === 0 ? (
            <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-8 text-center">
              <div className="text-2xl mb-2">✅</div>
              <div className="text-sm font-semibold text-green-400">No duplicate groups detected</div>
              <div className="text-xs text-[#64748b] mt-1">All groups have unique names</div>
            </div>
          ) : (
            <div className="space-y-3">
              {duplicates.map((d, i) => (
                <div key={i} className="bg-[#0d1117] border border-yellow-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{d.group_a.name}</div>
                      <div className="text-[10px] text-[#64748b] font-mono">{shortJid(d.group_a.jid)}</div>
                    </div>
                    <div className="text-[#64748b] text-lg">↓</div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{d.group_b.name}</div>
                      <div className="text-[10px] text-[#64748b] font-mono">{shortJid(d.group_b.jid)}</div>
                    </div>
                    <div className="text-[10px] text-yellow-400 bg-yellow-500/10 px-2 py-1 rounded">
                      {d.match_type === "name_similarity" ? "Similar name" : d.match_type}
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
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Tab: Full Diagnostics ─── */}
      {activeTab === "health" && captureHealth && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <HealthCard label="Webhook Status" value={captureHealth.webhook_healthy ? "Healthy" : "Down"} good={captureHealth.webhook_healthy} bad={!captureHealth.webhook_healthy} />
          <HealthCard label="Msgs Last Hour" value={captureHealth.msgs_last_hour} />
          <HealthCard label="Avg Process Time" value={captureHealth.avg_process_secs != null ? `${captureHealth.avg_process_secs}s` : "—"} />
          <HealthCard label="Parser Queue" value={captureHealth.pending_enrichment} neutral={captureHealth.pending_enrichment > 0} />
          <HealthCard label="Failed Events" value={captureHealth.failed_enrichment} good={captureHealth.failed_enrichment === 0} bad={captureHealth.failed_enrichment > 0} />
          <HealthCard label="Retry Count" value={captureHealth.retry_count} neutral={captureHealth.retry_count > 0} />
          <HealthCard label="Parser Success" value={`${captureHealth.parser_success_rate}%`} good={captureHealth.parser_success_rate > 80} neutral={captureHealth.parser_success_rate > 50 && captureHealth.parser_success_rate <= 80} bad={captureHealth.parser_success_rate <= 50} />
          <HealthCard label="Msgs Today" value={captureHealth.total_msgs_today.toLocaleString()} detail={`${captureHealth.total_parsed_today.toLocaleString()} parsed`} />
        </div>
      )}
    </div>
  );
}
