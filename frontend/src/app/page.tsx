"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";

interface ActionCard {
  label: string;
  count: number;
  icon: string;
  color: string;
  href: string;
  detail?: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [actions, setActions] = useState<any>(null);
  const [activity, setActivity] = useState<api.DashboardActivity | null>(null);
  const [feed, setFeed] = useState<any[]>([]);
  const [coverage, setCoverage] = useState<api.DashboardCoverage | null>(null);
  const [suggestionCounts, setSuggestionCounts] = useState<any>({});

  const loadAll = useCallback(async () => {
    try {
      const [act, cov, f, a, sc] = await Promise.all([
        api.getDashboardActivity(),
        api.getDashboardCoverage(),
        api.getDashboardFeed(10),
        api.getActionDashboard(),
        api.getChatSuggestions(),
      ]);
      setActivity(act);
      setCoverage(cov);
      setFeed(f);
      setActions(a);
      setSuggestionCounts(sc);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEventStream({
    "message.received": loadAll,
    "extraction.completed": loadAll,
    "resolution.completed": loadAll,
    "sync.completed": loadAll,
    "connection.changed": loadAll,
  });

  const actionCards: ActionCard[] = [
    { label: "Pending Review", count: actions?.pending_review_unresolved ?? 0, icon: "📋", color: "yellow", href: "/resolver?method=unresolved", detail: "Messages needing location resolution" },
    { label: "AI Suggestions", count: actions?.pending_ai_suggestions ?? 0, icon: "🤖", color: "blue", href: "/chat?tab=review", detail: "Awaiting your approval" },
    { label: "New Buildings Today", count: actions?.new_buildings_today ?? 0, icon: "🏗️", color: "green", href: "/buildings", detail: "Discovered from WhatsApp" },
    { label: "Duplicate Brokers", count: actions?.duplicate_brokers_detected ?? 0, icon: "🤝", color: "purple", href: "/chat?tab=review", detail: "Merge candidates" },
    { label: "Duplicate Listings", count: actions?.duplicate_listings_detected ?? 0, icon: "🏠", color: "orange", href: "/chat?tab=review", detail: "Potential merges" },
    { label: "Low Confidence", count: actions?.low_confidence_parses ?? 0, icon: "⚠️", color: "red", href: "/resolver?method=unresolved", detail: "Parser confidence < 50%" },
    { label: "Unknown Locations", count: actions?.unknown_locations ?? 0, icon: "🗺️", color: "yellow", href: "/resolver?method=unresolved", detail: "Not yet mapped" },
    { label: "Buildings Pending", count: actions?.buildings_pending_approval ?? 0, icon: "🏢", color: "blue", href: "/chat?tab=review", detail: "AI suggestions for buildings" },
  ];

  const types = activity?.message_types || {};
  const suggestionPending = suggestionCounts?.pending ?? 0;

  return (
    <div className="space-y-6">
      {/* Today's Pulse — minimal, shows rhythm */}
      <div>
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">TODAY&apos;S PULSE</div>
        <div className="flex gap-2.5 flex-wrap">
          {[
            { label: "Messages", val: activity?.messages_today ?? "—", color: "blue" },
            { label: "Supply", val: types.SELL ?? 0, color: "green" },
            { label: "Demand", val: types.BUY ?? 0, color: "purple" },
            { label: "Rentals", val: types.RENT ?? 0, color: "yellow" },
          ].map(s => (
            <div key={s.label} className={`stat-card ${s.color}`}>
              <div className="val">{s.val}</div>
              <div className="lbl">{s.label}</div>
            </div>
          ))}
          <div className={`stat-card ${suggestionPending > 0 ? 'orange' : 'blue'}`}>
            <div className="val">{suggestionPending}</div>
            <div className="lbl">To Review</div>
          </div>
        </div>
      </div>

      {/* Action Cards */}
      <div>
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">ACTION CENTER</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {actionCards.map(card => (
            <button
              key={card.label}
              onClick={() => router.push(card.href)}
              className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-left hover:border-[rgba(255,255,255,0.15)] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-lg">{card.icon}</span>
                <span className={`text-2xl font-bold text-${card.color}-400`}>{card.count}</span>
              </div>
              <div className="text-xs font-medium text-[#e2e8f0]">{card.label}</div>
              {card.detail && <div className="text-[10px] text-[#64748b] mt-0.5">{card.detail}</div>}
            </button>
          ))}
        </div>
      </div>

      {/* Parser Failure Breakdown */}
      {actions?.top_parser_failures && actions.top_parser_failures.length > 0 && (
        <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
          <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">TOP PARSER FAILURES</div>
          <div className="space-y-2">
            {actions.top_parser_failures.map((f: any, i: number) => {
              const maxCount = actions.top_parser_failures[0]?.c || 1;
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-[#94a3b8] w-32 truncate shrink-0">{f.failure_category}</span>
                  <div className="flex-1 h-4 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden">
                    <div className="h-full bg-orange-500/60 rounded-full" style={{ width: `${Math.max(3, (f.c / maxCount) * 100)}%` }} />
                  </div>
                  <span className="text-xs text-[#64748b] w-8 text-right">{f.c}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Feed (compact) */}
      <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">RECENT ACTIVITY</div>
        <div className="max-h-[240px] overflow-y-auto">
          {feed.length === 0 ? (
            <div className="text-[#64748b] text-center py-5">No messages yet</div>
          ) : (
            feed.map((f, i) => {
              const color = ({ SELL: "green", BUY: "purple", RENT: "yellow" } as Record<string, string>)[f.intent] || "blue";
              return (
                <div key={i} className="feed-item">
                  <div className="feed-header">
                    <span className={`badge badge-${color}`}>{f.intent || "TEXT"}</span>
                    {f.broker_name && <span className="font-semibold text-[#f0f6fc] text-xs">{f.broker_name}</span>}
                    <span className="feed-time">{f.timestamp ? new Date(f.timestamp + "Z").toLocaleTimeString() : ""}</span>
                    <span className="feed-group">{f.group_name?.slice(0, 20) || ""}</span>
                  </div>
                  <div className="feed-msg">{(f.message || "").slice(0, 200)}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
