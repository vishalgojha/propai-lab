"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";
import { LatestWhatsAppKnowledge } from "@/components/dashboard/LatestWhatsAppKnowledge";

interface ActionCard {
  label: string;
  count: number;
  icon: string;
  color: string;
  href: string;
  detail?: string;
}

const cardValueClass: Record<string, string> = {
  blue: "text-blue-400",
  green: "text-emerald-400",
  yellow: "text-yellow-400",
  purple: "text-purple-400",
  orange: "text-orange-400",
  red: "text-red-400",
};

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
    { label: "Open Market Inbox", count: activity?.messages_today ?? 0, icon: "💬", color: "blue", href: "/inbox", detail: "WhatsApp-style broker workspace" },
    { label: "Search Knowledge", count: coverage?.messages_stored ?? 0, icon: "🔎", color: "green", href: "/knowledge", detail: "Find any property, broker, group, or phrase" },
    { label: "Review Items", count: actions?.low_confidence_parses ?? 0, icon: "✅", color: "yellow", href: "/chat?tab=review", detail: "Only records that need confirmation" },
    { label: "Capture Health", count: coverage?.groups_connected ?? 0, icon: "📡", color: "purple", href: "/audit", detail: "Groups and messages being remembered" },
  ];

  const types = activity?.message_types || {};
  const suggestionPending = suggestionCounts?.pending ?? 0;

  return (
    <div className="space-y-6">
      {/* Market Pulse */}
      <div>
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">MARKET PULSE</div>
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
          <div className={`stat-card ${suggestionPending > 0 ? "orange" : "blue"}`}>
            <div className="val">{suggestionPending}</div>
            <div className="lbl">To Review</div>
          </div>
        </div>
      </div>

      {/* Action Cards */}
      <div>
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">BROKER ACTIONS</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {actionCards.map(card => (
            <button
              key={card.label}
              onClick={() => router.push(card.href)}
              className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-left hover:border-[rgba(255,255,255,0.15)] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-lg">{card.icon}</span>
                <span className={`text-2xl font-bold ${cardValueClass[card.color] || "text-blue-400"}`}>{card.count}</span>
              </div>
              <div className="text-xs font-medium text-[#e2e8f0]">{card.label}</div>
              {card.detail && <div className="text-[10px] text-[#64748b] mt-0.5">{card.detail}</div>}
            </button>
          ))}
        </div>
      </div>

      <LatestWhatsAppKnowledge feed={feed} onOpenInbox={() => router.push("/inbox")} />
    </div>
  );
}
