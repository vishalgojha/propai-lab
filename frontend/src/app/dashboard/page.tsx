"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";
import { LatestWhatsAppKnowledge } from "@/components/dashboard/LatestWhatsAppKnowledge";
import { ChevronDown, TrendingUp, TrendingDown, ArrowRight, MessageCircle, Building2, Target, Home, AlertTriangle, Search, ListChecks, Radio } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";

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
  { key: "messages", label: "Messages", icon: MessageCircle, color: "text-blue-400", bg: "bg-blue-500/10" },
  { key: "supply", label: "Supply", icon: Building2, color: "text-emerald-400", bg: "bg-emerald-500/10" },
  { key: "demand", label: "Requirements", icon: Target, color: "text-purple-400", bg: "bg-purple-500/10" },
  { key: "rentals", label: "Rentals", icon: Home, color: "text-yellow-400", bg: "bg-yellow-500/10" },
  { key: "needs_review", label: "Needs Review", icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/10" },
];

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [window, setWindow] = useState("today");
  const [metrics, setMetrics] = useState<api.TimeWindowMetrics | null>(null);
  const [feed, setFeed] = useState<any[]>([]);
  const [actionCards, setActionCards] = useState<any>(null);
  const [suggestionCounts, setSuggestionCounts] = useState<any>({});
  const [loadingData, setLoadingData] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/auth/login?next=/dashboard");
    }
  }, [user, loading, router]);

  const loadAll = useCallback(async () => {
    if (!user) return;
    setLoadingData(true);
    setDataError(null);
    try {
      const [metricsResult, feedResult, actionResult, suggestionsResult] = await Promise.allSettled([
        api.getTimeWindowMetrics(window),
        api.getDashboardFeed(10),
        api.getActionDashboard(),
        api.getChatSuggestions(),
      ]);

      if (metricsResult.status === "rejected") {
        throw metricsResult.reason;
      }

      setMetrics(metricsResult.value);
      if (feedResult.status === "fulfilled") setFeed(feedResult.value);
      if (actionResult.status === "fulfilled") setActionCards(actionResult.value);
      if (suggestionsResult.status === "fulfilled") setSuggestionCounts(suggestionsResult.value);

      const auxiliaryFailures = [feedResult, actionResult, suggestionsResult]
        .filter((result) => result.status === "rejected").length;
      if (auxiliaryFailures > 0) {
        console.warn(`[dashboard] ${auxiliaryFailures} auxiliary request(s) failed; core metrics remain visible`);
      }
    } catch (e) {
      console.error(e);
      setDataError("Market activity could not be loaded. Check your connection and try again.");
    } finally {
      setLoadingData(false);
    }
  }, [user, window]);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEventStream({
    "message.received": loadAll,
    "extraction.completed": loadAll,
    "resolution.completed": loadAll,
    "sync.completed": loadAll,
    "connection.changed": loadAll,
  });

  if (loading || !user) {
    return null;
  }

  const suggestionPending = suggestionCounts?.pending ?? 0;

  return (
    <div className="propai-dashboard-page space-y-6">
      {/* Time Window Selector */}
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold">
          {window === "today" ? "Today's Market" : metrics?.label || "Market Activity"}
        </div>
        <div className="flex gap-1 bg-zinc-900 border border-white/10 rounded-lg p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWindow(w.key)}
              className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors ${
                window === w.key
                  ? "bg-zinc-800 text-[#3EE88A] shadow-sm"
                  : "text-zinc-500 hover:text-white"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {dataError && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-orange-300/30 bg-orange-50/70 px-4 py-3 text-sm text-orange-950">
          <span>{dataError}</span>
          <button type="button" onClick={() => void loadAll()} className="shrink-0 rounded-lg border border-orange-300/50 px-3 py-1.5 text-xs font-semibold hover:bg-orange-100">Try again</button>
        </div>
      )}

      {/* Market Pulse Cards */}
      {!dataError && loadingData && <div className="rounded-xl border border-zinc-200 bg-white/60 px-4 py-3 text-sm text-zinc-600" aria-live="polite">Loading market activity…</div>}
      {!dataError && !loadingData && metrics && <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
        {METRICS.map((m) => {
          const MetricIcon = m.icon;
          const val = metrics?.[m.key as keyof api.TimeWindowMetrics] as number ?? 0;
          const totalKey = `total_${m.key}` as keyof api.TimeWindowMetrics;
          const totalVal = metrics?.[totalKey] as number ?? 0;
          return (
            <div key={m.key} className="bg-zinc-900 border border-white/10 rounded-2xl p-4 hover:border-[rgba(255,255,255,0.15)] transition-colors">
              <div className="flex items-center justify-between mb-1">
                <MetricIcon className={`h-4 w-4 ${m.color}`} strokeWidth={1.7} />
                <span className={`text-2xl font-bold ${m.color}`}>{val}</span>
              </div>
              <div className="text-xs font-medium text-white">{m.label}</div>
              {window !== "all" && (
                <div className="text-[10px] text-zinc-500 mt-0.5">
                  {totalVal.toLocaleString()} total
                </div>
              )}
            </div>
          );
        })}
      </div>
      }

      {/* Broker Actions */}
      <div>
        <div className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold mb-3">BROKER ACTIONS</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
          {[
            { label: "Open Market Inbox", count: "→", icon: MessageCircle, href: "/inbox", detail: "WhatsApp-style broker workspace" },
            { label: "Search Listings", count: "→", icon: Search, href: "/chat", detail: "Find any property, broker, group" },
            { label: "Review Items", count: suggestionPending || "→", icon: ListChecks, href: "/chat?tab=review", detail: "Records needing confirmation" },
            { label: "Manage Groups", count: suggestionPending || "→", icon: Radio, href: "/connections", detail: "Choose groups to connect for parsing" },
          ].map(card => (
            <button
              key={card.label}
              onClick={() => router.push(card.href)}
              className="bg-zinc-900 border border-white/10 rounded-2xl p-4 text-left hover:border-[rgba(255,255,255,0.15)] transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between mb-1">
                <card.icon className="h-4 w-4 text-zinc-400" strokeWidth={1.7} />
                {typeof card.count === "number" && card.count > 0 ? (
                  <span className="text-2xl font-bold text-yellow-400">{card.count}</span>
                ) : (
                  <ArrowRight className="w-5 h-5 text-zinc-500" strokeWidth={1.5} />
                )}
              </div>
              <div className="text-xs font-medium text-white">{card.label}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5">{card.detail}</div>
            </button>
          ))}
        </div>
      </div>

      {!dataError && !loadingData && <LatestWhatsAppKnowledge feed={feed} onOpenInbox={() => router.push("/inbox")} />}
    </div>
  );
}
