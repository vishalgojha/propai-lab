"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";
import { LatestWhatsAppKnowledge } from "@/components/dashboard/LatestWhatsAppKnowledge";
import { ArrowRight, MessageCircle, Building2, Target, Home, AlertTriangle, Search, ListChecks, Radio, BarChart3, Clock3 } from "lucide-react";
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
  const [insights, setInsights] = useState<api.AuditInsights | null>(null);
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
      const [metricsResult, feedResult, actionResult, suggestionsResult, insightsResult] = await Promise.allSettled([
        api.getTimeWindowMetrics(window),
        api.getDashboardFeed(10),
        api.getActionDashboard(),
        api.getChatSuggestions(),
        api.getAuditInsights(),
      ]);

      if (metricsResult.status === "rejected") {
        throw metricsResult.reason;
      }

      setMetrics(metricsResult.value);
      if (feedResult.status === "fulfilled") setFeed(feedResult.value);
      if (actionResult.status === "fulfilled") setActionCards(actionResult.value);
      if (suggestionsResult.status === "fulfilled") setSuggestionCounts(suggestionsResult.value);
      if (insightsResult.status === "fulfilled") setInsights(insightsResult.value);

      const auxiliaryFailures = [feedResult, actionResult, suggestionsResult, insightsResult]
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

      {!dataError && !loadingData && insights && (
        <section className="border-t border-zinc-200/80 pt-6" aria-labelledby="observed-intelligence-heading">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 id="observed-intelligence-heading" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-zinc-900">
                <BarChart3 className="h-5 w-5 text-[var(--accent-primary)]" strokeWidth={1.8} />
                Observed intelligence
              </h2>
              <p className="mt-1 max-w-2xl text-sm text-zinc-600">Measured activity from captured WhatsApp evidence, kept separate from market-wide claims.</p>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
              <Clock3 className="h-3.5 w-3.5" strokeWidth={1.8} />
              Last 7 days · workspace scope
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-2xl border border-zinc-200 bg-white/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Captured flow</div>
              <div className="mt-4 divide-y divide-zinc-200/80">
                {insights.daily_flow.length ? insights.daily_flow.map((point) => (
                  <div key={point.date} className="flex items-center justify-between gap-4 py-2.5 text-sm">
                    <span className="text-zinc-600">{new Date(point.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</span>
                    <span className="tabular-nums text-zinc-900"><b>{point.posts.toLocaleString("en-IN")}</b> messages · {point.listings.toLocaleString("en-IN")} listings · {point.requirements.toLocaleString("en-IN")} requirements</span>
                  </div>
                )) : <p className="py-4 text-sm text-zinc-600">No captured activity in this window.</p>}
              </div>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white/70 p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Captured locality mentions</div>
              <div className="mt-4 space-y-3">
                {insights.markets.length ? insights.markets.slice(0, 5).map((market) => (
                  <div key={market.name} className="flex items-center justify-between gap-4">
                    <span className="truncate text-sm font-medium text-zinc-800">{market.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-zinc-600">{market.posts.toLocaleString("en-IN")} messages · {market.brokers.toLocaleString("en-IN")} broker signals</span>
                  </div>
                )) : <p className="text-sm text-zinc-600">No locality mentions captured yet.</p>}
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs leading-5 text-zinc-500">{insights.coverage_note || "Captured WhatsApp evidence in this workspace; not a complete market census."} Counts are descriptive and may be incomplete when groups are not connected or selected.</p>
        </section>
      )}

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
