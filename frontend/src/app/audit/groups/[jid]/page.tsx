"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import * as api from "@/lib/api";

function timeAgo(ts: string) {
  if (!ts) return "never";
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

export default function GroupDetailPage() {
  const params = useParams();
  const jid = decodeURIComponent(params.jid as string);
  const [group, setGroup] = useState<any>(null);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState("overview");

  useEffect(() => {
    async function load() {
      try {
        const [g, tl] = await Promise.all([
          api.getAuditGroupDetail(jid),
          api.getAuditGroupTimeline(jid),
        ]);
        setGroup(g);
        setTimeline(tl);
      } catch (e) {
        console.error("Failed to load group detail", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [jid]);

  if (loading) return <div className="text-center text-[#64748b] py-16">Loading...</div>;
  if (!group) return <div className="text-center text-[#64748b] py-16">Group not found</div>;

  const sections = ["overview", "timeline", "brokers", "markets", "buildings", "suggestions"];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <a href="/audit" className="text-[10px] text-[#64748b] hover:text-white mb-1 block">← WhatsApp Audit</a>
          <h1 className="text-lg font-semibold">{group.name}</h1>
          <div className="text-[11px] font-mono text-[#64748b]">{group.jid}</div>
        </div>
        <div className="flex gap-3 items-center">
          <div className="text-right">
            <div className="text-[10px] text-[#64748b]">Quality</div>
            <div className={`text-lg font-bold ${group.quality_score >= 80 ? "text-green-400" : group.quality_score >= 50 ? "text-yellow-400" : "text-red-400"}`}>
              {group.quality_score}%
            </div>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
          <div className="text-[10px] text-[#64748b]">Messages</div>
          <div className="text-lg font-bold">{group.messages.toLocaleString()}</div>
        </div>
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
          <div className="text-[10px] text-[#64748b]">Observations</div>
          <div className="text-lg font-bold">{group.observations}</div>
        </div>
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
          <div className="text-[10px] text-[#64748b]">Listings</div>
          <div className="text-lg font-bold">{group.listings}</div>
        </div>
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
          <div className="text-[10px] text-[#64748b]">Brokers</div>
          <div className="text-lg font-bold">{group.brokers}</div>
        </div>
      </div>

      {/* Section Nav */}
      <div className="flex gap-1 text-xs border-b border-[rgba(255,255,255,0.06)] pb-2 flex-wrap">
        {sections.map((s) => (
          <button key={s} onClick={() => setActiveSection(s)}
            className={`px-3 py-1.5 rounded-lg font-medium capitalize ${
              activeSection === s ? "bg-blue-600 text-white" : "text-[#94a3b8] hover:text-white"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeSection === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Data Quality</h3>
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs text-[#94a3b8] mb-1">
                  <span>Resolution Rate</span>
                  <span className="text-white">{group.quality_score}%</span>
                </div>
                <div className="h-2 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-blue-500" style={{ width: `${group.quality_score}%` }} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-[rgba(255,255,255,0.03)] rounded-lg p-2">
                  <div className="text-[#64748b]">Resolved</div>
                  <div className="text-green-400 font-semibold">{group.resolved}</div>
                </div>
                <div className="bg-[rgba(255,255,255,0.03)] rounded-lg p-2">
                  <div className="text-[#64748b]">Unresolved</div>
                  <div className="text-red-400 font-semibold">{group.unresolved}</div>
                </div>
              </div>
            </div>
          </div>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Known Markets</h3>
            {group.markets.length === 0 ? (
              <div className="text-xs text-[#64748b]">No markets identified yet</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {group.markets.map((m: string) => (
                  <span key={m} className="text-xs bg-blue-500/10 text-blue-400 px-2 py-0.5 rounded">{m}</span>
                ))}
              </div>
            )}
          </div>
          {/* Buildings */}
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Buildings Mentioned</h3>
            {group.buildings.length === 0 ? (
              <div className="text-xs text-[#64748b]">No buildings identified yet</div>
            ) : (
              <div className="space-y-1.5">
                {group.buildings.map((b: any) => (
                  <div key={b.building_name} className="flex justify-between text-xs">
                    <span className="text-white">{b.building_name}</span>
                    <span className="text-[#64748b]">{b.occurrences}x</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <h3 className="text-xs font-semibold text-[#94a3b8] uppercase tracking-wider mb-3">Group Info</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-[#64748b]">First Seen</span>
                <span className="text-white">{group.first_seen ? new Date(group.first_seen).toLocaleDateString("en-IN") : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#64748b]">Last Seen</span>
                <span className="text-white">{timeAgo(group.last_seen)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#64748b]">Requirements</span>
                <span className="text-white">{group.requirements}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#64748b]">Sync Status</span>
                <span className="text-white">{group.sync_status?.status || "unknown"}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Timeline */}
      {activeSection === "timeline" && (
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 max-h-[600px] overflow-y-auto">
          {timeline.length === 0 ? (
            <div className="text-xs text-[#64748b] text-center py-8">No events yet</div>
          ) : (
            <div className="space-y-0">
              {timeline.map((ev: any, i: number) => {
                const dotColor = ev.type === "message" ? "bg-blue-500" : ev.type === "resolve" ? "bg-green-500" : "bg-violet-500";
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
                        <span className="text-xs">{ev.label}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Brokers */}
      {activeSection === "brokers" && (
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-6 text-center">
          <div className="text-sm text-[#64748b]">{group.brokers} unique brokers observed in this group</div>
          <div className="text-xs text-[#64748b] mt-1">View broker details in the Brokers section</div>
          <a href="/brokers" className="inline-block mt-3 text-xs text-blue-400 hover:text-blue-300">Go to Brokers →</a>
        </div>
      )}

      {/* Markets */}
      {activeSection === "markets" && (
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
          {group.markets.length === 0 ? (
            <div className="text-xs text-[#64748b] text-center py-8">No markets identified yet</div>
          ) : (
            <div className="space-y-2">
              {group.markets.map((m: string) => (
                <div key={m} className="flex items-center gap-2 text-sm">
                  <span className="text-blue-400">📍</span>
                  <span>{m}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Buildings */}
      {activeSection === "buildings" && (
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
          {group.buildings.length === 0 ? (
            <div className="text-xs text-[#64748b] text-center py-8">No buildings identified yet</div>
          ) : (
            <div className="space-y-2">
              {group.buildings.map((b: any) => (
                <div key={b.building_name} className="flex justify-between items-center text-sm py-1 border-b border-[rgba(255,255,255,0.03)] last:border-0">
                  <span className="text-white">{b.building_name}</span>
                  <span className="text-[#64748b] text-xs">{b.occurrences} occurrences</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Suggestions */}
      {activeSection === "suggestions" && (
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
          {group.suggestions.length === 0 ? (
            <div className="text-xs text-[#64748b] text-center py-8">No AI suggestions for this group</div>
          ) : (
            <div className="space-y-2">
              {group.suggestions.map((s: any) => (
                <div key={s.id} className="flex items-start gap-2 text-xs border-b border-[rgba(255,255,255,0.03)] py-2">
                  <span className="text-blue-400 mt-0.5">🤖</span>
                  <div className="flex-1">
                    <div className="text-white">{s.title}</div>
                    <div className="text-[#64748b]">{s.agent} · {Math.round(s.confidence * 100)}% · {s.status}</div>
                  </div>
                  <span className="text-[#64748b]">{new Date(s.created_at).toLocaleDateString("en-IN")}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
