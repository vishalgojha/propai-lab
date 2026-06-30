"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";
import { LatestWhatsAppKnowledge } from "@/components/dashboard/LatestWhatsAppKnowledge";
import { ChevronDown, TrendingUp, TrendingDown, ArrowRight } from "lucide-react";

interface WindowOption {
  key: string;
  label: string;
}

const WINDOWS: WindowOption[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 Days" },
  { key: "30d", label: "30 Days" },
  { key: "all", label: "All Time" },
];

const METRICS = [
  { key: "messages", label: "Messages", icon: "💬", color: "text-blue-400", bg: "bg-blue-500/10" },
  { key: "supply", label: "Supply", icon: "🏢", color: "text-emerald-400", bg: "bg-emerald-500/10" },
  { key: "demand", label: "Requirements", icon: "🎯", color: "text-purple-400", bg: "bg-purple-500/10" },
  { key: "rentals", label: "Rentals", icon: "🏠", color: "text-yellow-400", bg: "bg-yellow-500/10" },
  { key: "needs_review", label: "Needs Review", icon: "⚠️", color: "text-orange-400", bg: "bg-orange-500/10" },
];

export default function DashboardPage() {
  const router = useRouter();
  const [window, setWindow] = useState("today");
  const [metrics, setMetrics] = useState<api.TimeWindowMetrics | null>(null);
  const [feed, setFeed] = useState<any[]>([]);
  const [actionCards, setActionCards] = useState<any>(null);
  const [suggestionCounts, setSuggestionCounts] = useState<any>({});

  const loadAll = useCallback(async () => {
    try {
      const [m, f, a, sc] = await Promise.all([
        api.getTimeWindowMetrics(window),
        api.getDashboardFeed(10),
        api.getActionDashboard(),
        api.getChatSuggestions(),
      ]);
      setMetrics(m);
      setFeed(f);
      setActionCards(a);
      setSuggestionCounts(sc);
    } catch (e) { console.error(e); }
  }, [window]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEventStream({
    "message.received": loadAll,
    "extraction.completed": loadAll,
    "resolution.completed": loadAll,
    "sync.completed": loadAll,
    "connection.changed": loadAll,
  });

  const suggestionPending = suggestionCounts?.pending ?? 0;

  return (
    <div className="space-y-6">
      {/* Time Window Selector */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold">
          {window === "today" ? "Today's Market" : metrics?.label || "Market Activity"}
        </div>
        <div className="flex gap-1 bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-lg p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWindow(w.key)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors ${
                window === w.key
                  ? "bg-[#111820] text-[#3EE88A] shadow-sm"
                  : "text-[#64748b] hover:text-white"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Market Pulse Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
        {METRICS.map((m) => {
          const val = metrics?.[m.key as keyof api.TimeWindowMetrics] as number ?? 0;
          const totalKey = `total_${m.key}` as keyof api.TimeWindowMetrics;
          const totalVal = metrics?.[totalKey] as number ?? 0;
          return (
            <div key={m.key} className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 hover:border-[rgba(255,255,255,0.15)] transition-colors">
              <div className="flex items-center justify-between mb-1">
                <span className="text-lg">{m.icon}</span>
                <span className={`text-2xl font-bold ${m.color}`}>{val}</span>
              </div>
              <div className="text-xs font-medium text-[#e2e8f0]">{m.label}</div>
              {window !== "all" && (
                <div className="text-[10px] text-[#64748b] mt-0.5">
                  {totalVal.toLocaleString()} total
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Broker Actions */}
      <div>
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">BROKER ACTIONS</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {[
            { label: "Open Market Inbox", count: "→", icon: "💬", href: "/inbox", detail: "WhatsApp-style broker workspace" },
            { label: "Search Knowledge", count: "→", icon: "🔎", href: "/knowledge", detail: "Find any property, broker, group" },
            { label: "Review Items", count: suggestionPending || "→", icon: "✅", href: "/chat?tab=review", detail: "Records needing confirmation" },
            { label: "Capture Health", count: suggestionPending || "→", icon: "📡", href: "/audit", detail: "Groups and messages being remembered" },
          ].map(card => (
            <button
              key={card.label}
              onClick={() => router.push(card.href)}
              className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-left hover:border-[rgba(255,255,255,0.15)] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-lg">{card.icon}</span>
                {typeof card.count === "number" && card.count > 0 ? (
                  <span className="text-2xl font-bold text-yellow-400">{card.count}</span>
                ) : (
                  <ArrowRight className="w-5 h-5 text-[#64748b]" strokeWidth={1.5} />
                )}
              </div>
              <div className="text-xs font-medium text-[#e2e8f0]">{card.label}</div>
              <div className="text-[10px] text-[#64748b] mt-0.5">{card.detail}</div>
            </button>
          ))}
        </div>
      </div>

      <LatestWhatsAppKnowledge feed={feed} onOpenInbox={() => router.push("/inbox")} />
    </div>
  );
}
