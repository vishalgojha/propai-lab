"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as api from "@/lib/api";
import { useEventStream } from "@/lib/useEventStream";
import { LatestWhatsAppKnowledge } from "@/components/dashboard/LatestWhatsAppKnowledge";
import { ArrowRight, MessageCircle, Building2, Target, Home, AlertTriangle, Search, ListChecks, Radio, BarChart3, Clock3 } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

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
  { key: "needs_review", label: "Being Verified", icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/10" },
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
  const [groups, setGroups] = useState<api.AuditGroupCard[]>([]);
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
      const [metricsResult, feedResult, actionResult, suggestionsResult, insightsResult, groupsResult] = await Promise.allSettled([
        api.getTimeWindowMetrics(window),
        api.getDashboardFeed(10),
        api.getActionDashboard(),
        api.getChatSuggestions(),
        api.getAuditInsights(),
        api.getAuditGroups("", "live"),
      ]);

      if (metricsResult.status === "rejected") {
        throw metricsResult.reason;
      }

      setMetrics(metricsResult.value);
      if (feedResult.status === "fulfilled") setFeed(feedResult.value);
      if (actionResult.status === "fulfilled") setActionCards(actionResult.value);
      if (suggestionsResult.status === "fulfilled") setSuggestionCounts(suggestionsResult.value);
      if (insightsResult.status === "fulfilled") setInsights(insightsResult.value);
      if (groupsResult.status === "fulfilled") setGroups(groupsResult.value.groups);

      const auxiliaryFailures = [feedResult, actionResult, suggestionsResult, insightsResult, groupsResult]
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
  const brokerSignals = insights?.brokers?.slice(0, 6) ?? [];
  const groupSignals = groups.slice().sort((a, b) => b.messages - a.messages).slice(0, 6);

  return (
    <div className="propai-dashboard-page space-y-7">
      <header className="dashboard-heading">
        <div>
          <p className="propai-kicker">Broker OS / workspace pulse</p>
          <h1>Market activity</h1>
          <p className="dashboard-heading-copy">A live view of captured WhatsApp evidence, extraction, and the next useful action.</p>
        </div>
        <div className="dashboard-window-control" aria-label="Choose activity window">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWindow(w.key)}
              aria-pressed={window === w.key}
              className="dashboard-window-button"
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      {dataError && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-orange-300/30 bg-orange-50/70 px-4 py-3 text-sm text-orange-950">
          <span>{dataError}</span>
          <button type="button" onClick={() => void loadAll()} className="shrink-0 rounded-lg border border-orange-300/50 px-3 py-1.5 text-xs font-semibold hover:bg-orange-100">Try again</button>
        </div>
      )}

      {!dataError && loadingData && <div className="dashboard-loading" aria-live="polite"><span className="dashboard-loading-dot" /> Syncing the latest workspace activity…</div>}
      {!dataError && !loadingData && metrics && <section aria-labelledby="pulse-heading">
        <div className="dashboard-section-heading">
          <div><h2 id="pulse-heading">Pulse</h2><p>{metrics.label || "Selected time window"} · live workspace totals</p></div>
          <span className="dashboard-live-label"><span /> Live query</span>
        </div>
        <div className="dashboard-metric-grid">
        {METRICS.map((m) => {
          const MetricIcon = m.icon;
          const val = metrics?.[m.key as keyof api.TimeWindowMetrics] as number ?? 0;
          const totalKey = `total_${m.key}` as keyof api.TimeWindowMetrics;
          const totalVal = metrics?.[totalKey] as number ?? 0;
          return (
            <div key={m.key} className={`dashboard-metric-card dashboard-metric-${m.key}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="dashboard-metric-icon"><MetricIcon className={m.color} strokeWidth={1.7} /></span>
                <span className="dashboard-metric-value">{val.toLocaleString("en-IN")}</span>
              </div>
              <div className="dashboard-metric-label">{m.label}</div>
              {window !== "all" && (
                <div className="dashboard-metric-total">
                  {totalVal.toLocaleString()} total
                </div>
              )}
            </div>
          );
        })}
        </div>
      </section>
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
              {insights.daily_flow.length ? <ChartContainer config={{ posts: { label: "Messages", color: "#287D82" }, listings: { label: "Listings", color: "#2F6B3A" }, requirements: { label: "Requirements", color: "#D08A00" } }} className="mt-3 h-[190px] min-h-0"><AreaChart accessibilityLayer data={insights.daily_flow.slice(-7)} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}><CartesianGrid vertical={false} stroke="rgba(22,37,43,.1)" /><XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fill: "#49615F", fontSize: 10 }} tickFormatter={(value) => new Date(String(value)).toLocaleDateString("en-IN", { weekday: "short" })} /><YAxis tickLine={false} axisLine={false} allowDecimals={false} tick={{ fill: "#49615F", fontSize: 10 }} /><Tooltip content={<ChartTooltipContent />} /><Area type="monotone" dataKey="posts" name="Messages" stroke="var(--color-posts)" fill="var(--color-posts)" fillOpacity={0.08} strokeWidth={2} /><Area type="monotone" dataKey="listings" name="Listings" stroke="var(--color-listings)" fill="var(--color-listings)" fillOpacity={0.08} strokeWidth={2} /><Area type="monotone" dataKey="requirements" name="Requirements" stroke="var(--color-requirements)" fill="var(--color-requirements)" fillOpacity={0.08} strokeWidth={2} /></AreaChart></ChartContainer> : null}
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
              {insights.markets.length ? <ChartContainer config={{ posts: { label: "Messages", color: "#287D82" } }} className="mt-3 h-[190px] min-h-0"><BarChart accessibilityLayer data={insights.markets.slice(0, 5)} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}><CartesianGrid horizontal={false} stroke="rgba(22,37,43,.1)" /><XAxis type="number" hide allowDecimals={false} /><YAxis type="category" dataKey="name" width={90} tickLine={false} axisLine={false} tick={{ fill: "#49615F", fontSize: 10 }} tickFormatter={(value) => String(value).slice(0, 14)} /><Tooltip content={<ChartTooltipContent />} /><Bar dataKey="posts" name="Messages" fill="var(--color-posts)" radius={[0, 4, 4, 0]} /></BarChart></ChartContainer> : null}
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

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 bg-white/70 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Broker signals</div>
                  <p className="mt-1 text-sm text-zinc-600">Most observed contributors in the last 7 days.</p>
                </div>
                <button type="button" onClick={() => router.push("/admin/analytics")} className="text-xs font-semibold text-[var(--accent-primary)] hover:underline">View activity</button>
              </div>
              {brokerSignals.length ? <ChartContainer config={{ listings: { label: "Listings", color: "#287D82" }, requirements: { label: "Requirements", color: "#D08A00" } }} className="mt-3 h-[220px] min-h-0"><BarChart accessibilityLayer data={brokerSignals} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}><CartesianGrid horizontal={false} stroke="rgba(22,37,43,.1)" /><XAxis type="number" hide allowDecimals={false} /><YAxis type="category" dataKey="name" width={110} tickLine={false} axisLine={false} tick={{ fill: "#49615F", fontSize: 10 }} tickFormatter={(value) => String(value).slice(0, 17)} /><Tooltip content={<ChartTooltipContent />} /><Bar dataKey="listings" name="Listings" stackId="signal" fill="var(--color-listings)" radius={[0, 0, 0, 0]} /><Bar dataKey="requirements" name="Requirements" stackId="signal" fill="var(--color-requirements)" radius={[0, 4, 4, 0]} /></BarChart></ChartContainer> : <p className="py-8 text-sm text-zinc-600">Broker signals will appear as evidence is captured.</p>}
              <p className="mt-2 text-xs text-zinc-500">Stacked bars show typed opportunities attributed to each broker identity; messages are not treated as listings.</p>
            </div>

            <div className="rounded-2xl border border-zinc-200 bg-white/70 p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Live group activity</div>
                  <p className="mt-1 text-sm text-zinc-600">Connected groups with activity in the last 24 hours.</p>
                </div>
                <button type="button" onClick={() => router.push("/whatsapp?tab=groups")} className="text-xs font-semibold text-[var(--accent-primary)] hover:underline">Manage groups</button>
              </div>
              {groupSignals.length ? <ChartContainer config={{ listings: { label: "Listings", color: "#287D82" }, requirements: { label: "Requirements", color: "#D08A00" } }} className="mt-3 h-[220px] min-h-0"><BarChart accessibilityLayer data={groupSignals} layout="vertical" margin={{ top: 0, right: 8, left: 8, bottom: 0 }}><CartesianGrid horizontal={false} stroke="rgba(22,37,43,.1)" /><XAxis type="number" hide allowDecimals={false} /><YAxis type="category" dataKey="name" width={110} tickLine={false} axisLine={false} tick={{ fill: "#49615F", fontSize: 10 }} tickFormatter={(value) => String(value).slice(0, 17)} /><Tooltip content={<ChartTooltipContent />} /><Bar dataKey="listings" name="Listings" stackId="signal" fill="var(--color-listings)" /><Bar dataKey="requirements" name="Requirements" stackId="signal" fill="var(--color-requirements)" radius={[0, 4, 4, 0]} /></BarChart></ChartContainer> : <p className="py-8 text-sm text-zinc-600">Live group activity will appear when connected groups post.</p>}
              <p className="mt-2 text-xs text-zinc-500">Scope: live connected groups only. Use the group workspace for membership and source-level details.</p>
            </div>
          </div>
        </section>
      )}

      <section aria-labelledby="actions-heading">
        <div className="dashboard-section-heading"><div><h2 id="actions-heading">Move the work forward</h2><p>Jump straight into the parts of your workspace that need attention.</p></div></div>
        <div className="dashboard-action-grid">
          {[
            { label: "Open Market Inbox", count: "→", icon: MessageCircle, href: "/inbox", detail: "WhatsApp-style broker workspace" },
            { label: "Search Listings", count: "→", icon: Search, href: "/chat", detail: "Find any property, broker, group" },
            { label: "Review Items", count: suggestionPending || "→", icon: ListChecks, href: "/chat?tab=review", detail: "Records needing confirmation" },
            { label: "Manage Groups", count: suggestionPending || "→", icon: Radio, href: "/whatsapp?tab=groups", detail: "Choose groups to connect for parsing" },
          ].map(card => (
            <button
              key={card.label}
              onClick={() => router.push(card.href)}
              className="dashboard-action-card"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="dashboard-action-icon"><card.icon strokeWidth={1.7} /></span>
                {typeof card.count === "number" && card.count > 0 ? (
                    <span className="dashboard-action-count">{card.count}</span>
                ) : (
                    <ArrowRight className="w-5 h-5" strokeWidth={1.5} />
                )}
              </div>
              <div className="dashboard-action-label">{card.label}</div>
              <div className="dashboard-action-detail">{card.detail}</div>
            </button>
          ))}
        </div>
      </section>

      {!dataError && !loadingData && <LatestWhatsAppKnowledge feed={feed} onOpenInbox={() => router.push("/inbox")} />}
    </div>
  );
}
