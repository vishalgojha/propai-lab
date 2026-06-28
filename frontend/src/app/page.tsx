"use client";

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";

export default function DashboardPage() {
  const [activity, setActivity] = useState<api.DashboardActivity | null>(null);
  const [coverage, setCoverage] = useState<api.DashboardCoverage | null>(null);
  const [feed, setFeed] = useState<any[]>([]);
  const [heatmap, setHeatmap] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({});
  const [wa, setWA] = useState<api.WhatsAppStatus | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [a, c, f, h, s, w] = await Promise.all([
        api.getDashboardActivity(),
        api.getDashboardCoverage(),
        api.getDashboardFeed(),
        api.getDashboardHeatmap(),
        api.getStats(),
        api.getWhatsAppStatus(),
      ]);
      setActivity(a);
      setCoverage(c);
      setFeed(f);
      setHeatmap(h);
      setStats(s);
      setWA(w);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Subscribe to SSE events — reload data on changes
  useEventStream({
    "message.received": loadAll,
    "extraction.completed": loadAll,
    "resolution.completed": loadAll,
    "sync.completed": loadAll,
    "connection.changed": loadAll,
  });

  const types = activity?.message_types || {};
  const maxHeat = heatmap.length > 0 ? heatmap[0].c : 1;

  return (
    <div className="space-y-6">
      {/* Market Activity */}
      <div>
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">TODAY</div>
        <div className="flex gap-2.5 flex-wrap">
          {[
            { label: "Messages", val: activity?.messages_today ?? "—", color: "blue" },
            { label: "Supply", val: types.SELL ?? 0, color: "green" },
            { label: "Demand", val: types.BUY ?? 0, color: "purple" },
            { label: "Rentals", val: types.RENT ?? 0, color: "yellow" },
            { label: "Commercial", val: types.COMMERCIAL ?? 0, color: "orange" },
          ].map(s => (
            <div key={s.label} className={`stat-card ${s.color}`}>
              <div className="val">{s.val}</div>
              <div className="lbl">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Coverage + Accuracy */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">MARKET MEMORY</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              ["Groups", coverage?.groups_connected],
              ["Messages", coverage?.messages_stored],
              ["Listings", coverage?.listings_known],
              ["Buildings", coverage?.buildings_known],
              ["Landmarks", coverage?.landmarks_known],
              ["Developers", coverage?.developers_known],
              ["Markets", coverage?.micro_markets_known],
            ].map(([l, v]) => (
              <div key={l as string}>
                <div className="text-3xl font-bold text-[#e2e8f0]">{v ?? "—"}</div>
                <div className="text-[11px] text-[#64748b]">{l as string}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">RESOLVER ACCURACY</div>
          <div className="flex gap-2.5 flex-wrap mb-3">
            {[
              { label: "Auto", val: stats.resolved ?? 0, color: "green" },
              { label: "Review", val: stats.unresolved ?? 0, color: "yellow" },
              { label: "Failed", val: stats.errors ?? 0, color: "red" },
            ].map(s => (
              <div key={s.label} className={`stat-card ${s.color}`} style={{ minWidth: 80 }}>
                <div className="val" style={{ fontSize: 20 }}>{s.val}</div>
                <div className="lbl">{s.label}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-[#64748b]">
            Avg Confidence: <strong className="text-[#c9d1d9]">{stats.avg_accuracy ? (stats.avg_accuracy * 100).toFixed(1) + "%" : "—"}</strong>
            <span className="ml-3">Evaluated: <strong className="text-[#c9d1d9]">{stats.evaluated ?? 0}</strong></span>
          </div>
        </div>

        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">KNOWLEDGE GRAPH</div>
          <div className="grid grid-cols-2 gap-2">
            {[
              ["Buildings", coverage?.buildings_known],
              ["Landmarks", coverage?.landmarks_known],
              ["Developers", coverage?.developers_known],
            ].map(([l, v]) => (
              <div key={l as string}>
                <div className="text-3xl font-bold text-[#e2e8f0]">{v ?? "—"}</div>
                <div className="text-[11px] text-[#64748b]">{l as string}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Feed + Heatmap */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5 md:col-span-2">
          <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">INTELLIGENCE FEED</div>
          <div className="max-h-[360px] overflow-y-auto">
            {feed.length === 0 ? (
              <div className="text-[#64748b] text-center py-5">No messages yet</div>
            ) : (
              feed.map((f, i) => {
                const detail = [f.bhk, f.furnishing, f.price ? `₹${Number(f.price).toLocaleString()}` : "", f.building_name, f.landmark_name, f.micro_market].filter(Boolean).join(" • ");
                const color = ({ SELL: "green", BUY: "purple", RENT: "yellow", COMMERCIAL: "orange", "PRE-LAUNCH": "red" } as Record<string, string>)[f.intent] || "blue";
                return (
                  <div key={i} className="feed-item">
                    <div className="feed-header">
                      <span className={`badge badge-${color}`}>{f.intent || "TEXT"}</span>
                      {f.broker_name && <span className="font-semibold text-[#f0f6fc] text-xs">{f.broker_name}</span>}
                      {f.principal && <span className="text-[11px] text-[#64748b]">• {f.principal}</span>}
                      <span className="feed-time">{f.timestamp ? new Date(f.timestamp + "Z").toLocaleTimeString() : ""}</span>
                      <span className="feed-group">{f.group_name?.slice(0, 20) || ""}</span>
                    </div>
                    <div className="feed-msg">{(f.message || "").slice(0, 200)}</div>
                    {detail && <div className="feed-detail">{detail}</div>}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">MARKET HEATMAP</div>
          <div className="max-h-[280px] overflow-y-auto">
            {heatmap.length === 0 ? (
              <div className="text-[#64748b] text-center py-3">No data yet</div>
            ) : (
              heatmap.slice(0, 15).map((h, i) => (
                <div key={i} className="heat-row">
                  <span className="heat-name">{h.micro_market}</span>
                  <div className="heat-bar"><div className="heat-fill" style={{ width: `${Math.max(3, (h.c / maxHeat) * 100)}%` }}></div></div>
                  <span className="heat-count">{h.c}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
