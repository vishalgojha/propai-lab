"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, DollarSign, AlertTriangle, RefreshCw, BarChart3 } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface ModelAgentRow {
  model: string;
  agent: string;
  calls: number;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
}

interface DailyBucket {
  date: string;
  calls: number;
  cost_usd: number;
  tokens_input: number;
  tokens_output: number;
}

interface WasteStats {
  calls: number;
  cost_usd: number;
}

interface AiUsageResponse {
  total_cost_usd: number;
  total_calls: number;
  total_tokens_input: number;
  total_tokens_output: number;
  by_model_agent: ModelAgentRow[];
  daily: DailyBucket[];
  waste: WasteStats;
}

interface OpenRouterUsageResponse {
  configured: boolean;
  message?: string;
  window_days?: number;
  totals?: { requests: number; prompt_tokens: number; completion_tokens: number; usage: number };
  by_model?: Array<{ model: string; requests: number; prompt_tokens: number; completion_tokens: number; usage: number }>;
  daily?: Array<{ date: string; requests: number; prompt_tokens: number; completion_tokens: number; usage: number }>;
  key?: { usage_daily?: number; usage_weekly?: number; usage_monthly?: number; limit?: number; limit_remaining?: number; limit_reset?: string };
}

function fmtUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function DailyChart({ daily }: { daily: DailyBucket[] }) {
  if (!daily.length) return <div className="text-xs text-zinc-500 italic">No data yet</div>;
  const maxCost = Math.max(...daily.map((d) => d.cost_usd), 0.001);
  return (
    <div className="flex items-end gap-1 h-24" title="Daily spend (USD)">
      {daily.map((d) => {
        const pct = (d.cost_usd / maxCost) * 100;
        return (
          <div
            key={d.date}
            className="flex-1 rounded-t bg-emerald-400/70 min-w-[6px] relative group"
            style={{ height: `${Math.max(pct, 2)}%` }}
            title={`${d.date}: ${fmtUsd(d.cost_usd)} (${d.calls} calls)`}
          />
        );
      })}
    </div>
  );
}

function DailyLabels({ daily }: { daily: DailyBucket[] }) {
  if (!daily.length) return null;
  const step = Math.max(1, Math.floor(daily.length / 6));
  return (
    <div className="flex gap-1 text-[9px] text-zinc-500 mt-1">
      {daily.map((d, i) => (
        <div key={d.date} className="flex-1 text-center" style={{ visibility: i % step === 0 ? "visible" : "hidden" }}>
          {d.date.slice(5)}
        </div>
      ))}
    </div>
  );
}

export default function AdminAiUsagePage() {
  const [data, setData] = useState<AiUsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const [openRouter, setOpenRouter] = useState<OpenRouterUsageResponse | null>(null);
  const [openRouterError, setOpenRouterError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchJSON<AiUsageResponse>(`/admin/ai-usage?days=${days}`);
      setData(res);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [days]);

  const loadOpenRouter = useCallback(async () => {
    try {
      const res = await fetchJSON<OpenRouterUsageResponse>("/admin/openrouter-usage");
      setOpenRouter(res);
      setOpenRouterError(null);
    } catch (e) {
      setOpenRouterError(e instanceof Error ? e.message : "OpenRouter usage could not be loaded");
    }
  }, []);

  useEffect(() => { void load(); void loadOpenRouter(); }, [load, loadOpenRouter]);

  const wastePct = useMemo(() => {
    if (!data || !data.total_cost_usd) return 0;
    return (data.waste.cost_usd / data.total_cost_usd) * 100;
  }, [data]);

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-zinc-400 hover:text-white">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <DollarSign className="w-6 h-6 text-emerald-400" />
              AI Usage &amp; Cost
            </h1>
            <p className="text-sm text-zinc-500">What did we spend and on what. Super admin view.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => { setDays(Number(e.target.value)); setLoading(true); }}
            className="px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm text-white focus:border-emerald-400 focus:outline-none"
          >
            <option value={7}>Last 7d</option>
            <option value={30}>Last 30d</option>
            <option value={90}>Last 90d</option>
          </select>
          <button
            onClick={() => { setLoading(true); load(); }}
            className="flex items-center gap-1 px-3 py-2 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/20 border border-emerald-400/30 rounded-lg text-sm"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {loading && !data ? (
        <div className="text-center py-12 text-zinc-500">Loading…</div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300">{error}</div>
      ) : data ? (
        <>
          {/* Headline numbers */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-8">
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Total Spend</div>
              <div className="text-2xl font-bold text-white">{fmtUsd(data.total_cost_usd)}</div>
              <div className="text-xs text-zinc-400 mt-1">{days}d window</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Total Calls</div>
              <div className="text-2xl font-bold text-white">{data.total_calls.toLocaleString()}</div>
              <div className="text-xs text-zinc-400 mt-1">{fmtTokens(data.total_tokens_input + data.total_tokens_output)} tokens</div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1">Input / Output</div>
              <div className="text-lg font-bold text-white">{fmtTokens(data.total_tokens_input)} <span className="text-zinc-500">/</span> {fmtTokens(data.total_tokens_output)}</div>
              <div className="text-xs text-zinc-400 mt-1">prompt / completion</div>
            </div>
            <div className={`rounded-2xl border p-5 ${wastePct > 5 ? "border-red-500/30 bg-red-500/5" : "border-white/10 bg-zinc-900/50"}`}>
              <div className="text-zinc-500 text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1">
                {wastePct > 5 && <AlertTriangle className="w-3 h-3 text-red-400" />}
                Wasted Spend
              </div>
              <div className={`text-2xl font-bold ${wastePct > 5 ? "text-red-300" : "text-white"}`}>{fmtUsd(data.waste.cost_usd)}</div>
              <div className="text-xs text-zinc-400 mt-1">{data.waste.calls} truncated/empty calls ({wastePct.toFixed(1)}%)</div>
            </div>
          </div>

          {/* Daily chart */}
          <section className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5 mb-8">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
              <BarChart3 className="w-4 h-4 text-emerald-400" />
              Daily Spend
            </h2>
            <DailyChart daily={data.daily} />
            <DailyLabels daily={data.daily} />
          </section>

          {/* Model × Agent table */}
          <section className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5">
            <h2 className="text-sm font-semibold text-white mb-3">Cost by Model &amp; Agent</h2>
            {data.by_model_agent.length === 0 ? (
              <div className="text-center py-8 text-zinc-500">
                No usage data yet. Run some extraction calls to start seeing costs.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-[11px] text-zinc-500 uppercase tracking-wider">
                      <th className="text-left px-3 py-2">Model</th>
                      <th className="text-left px-3 py-2">Agent</th>
                      <th className="text-right px-3 py-2">Calls</th>
                      <th className="text-right px-3 py-2">Tokens In</th>
                      <th className="text-right px-3 py-2">Tokens Out</th>
                      <th className="text-right px-3 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {data.by_model_agent.map((row, i) => (
                      <tr key={`${row.model}-${row.agent}-${i}`} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2 font-mono text-xs text-zinc-300 truncate max-w-[200px]" title={row.model}>{row.model}</td>
                        <td className="px-3 py-2">
                          <span className="px-2 py-0.5 rounded border border-emerald-400/20 bg-emerald-400/5 text-emerald-300 text-[10px] font-bold uppercase">
                            {row.agent}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-white font-mono">{row.calls.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-zinc-300 font-mono">{fmtTokens(row.tokens_input)}</td>
                        <td className="px-3 py-2 text-right text-zinc-300 font-mono">{fmtTokens(row.tokens_output)}</td>
                        <td className="px-3 py-2 text-right text-white font-semibold font-mono">{fmtUsd(row.cost_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.03] p-5">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-white">OpenRouter usage</h2>
                <p className="mt-1 text-xs text-zinc-500">Provider activity and key limits, last 30 completed UTC days.</p>
              </div>
              <span className="rounded-full border border-cyan-400/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-300">Management API</span>
            </div>
            {openRouterError ? (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{openRouterError}</div>
            ) : !openRouter?.configured ? (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 text-xs text-zinc-400">{openRouter?.message || "Configure OPENROUTER_MANAGEMENT_KEY on the API service to enable this panel."}</div>
            ) : openRouter.totals ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["Spend", fmtUsd(openRouter.totals.usage)],
                    ["Requests", openRouter.totals.requests.toLocaleString()],
                    ["Prompt tokens", fmtTokens(openRouter.totals.prompt_tokens)],
                    ["Completion tokens", fmtTokens(openRouter.totals.completion_tokens)],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-xl border border-white/10 bg-zinc-950/40 p-4">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
                      <div className="mt-1 text-xl font-semibold text-white">{value}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-5 grid gap-5 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">By model</h3>
                    <div className="space-y-2">
                      {(openRouter.by_model || []).slice(0, 8).map((row) => (
                        <div key={row.model} className="flex items-center justify-between gap-3 border-b border-white/5 py-2 text-xs">
                          <span className="truncate font-mono text-zinc-300" title={row.model}>{row.model}</span>
                          <span className="shrink-0 text-zinc-400">{fmtUsd(row.usage)} · {row.requests.toLocaleString()} req</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Key limits</h3>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg border border-white/10 p-3"><span className="text-zinc-500">Today</span><div className="mt-1 font-semibold text-white">{fmtUsd(Number(openRouter.key?.usage_daily || 0))}</div></div>
                      <div className="rounded-lg border border-white/10 p-3"><span className="text-zinc-500">This month</span><div className="mt-1 font-semibold text-white">{fmtUsd(Number(openRouter.key?.usage_monthly || 0))}</div></div>
                      <div className="rounded-lg border border-white/10 p-3"><span className="text-zinc-500">Remaining</span><div className="mt-1 font-semibold text-emerald-300">{openRouter.key?.limit_remaining == null ? "No limit" : fmtUsd(Number(openRouter.key.limit_remaining))}</div></div>
                      <div className="rounded-lg border border-white/10 p-3"><span className="text-zinc-500">Reset</span><div className="mt-1 font-semibold text-white">{openRouter.key?.limit_reset || "—"}</div></div>
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
