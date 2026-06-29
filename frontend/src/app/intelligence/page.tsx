"use client";

import { useEffect, useState } from "react";

interface Digest {
  period: string;
  total_messages: number;
  new_listings: number;
  new_requirements: number;
  top_markets: { market: string; count: number }[];
  top_buildings: { building: string; count: number }[];
  top_senders: { sender: string; phone: string; count: number }[];
}

interface Insight {
  type: string;
  title: string;
  description: string;
  action: string;
  priority: string;
}

interface Coverage {
  total_markets: number;
  balanced_markets: number;
  supply_heavy: number;
  demand_heavy: number;
  markets: { market: string; mentions: number; status: string }[];
}

export default function IntelligencePage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/knowledge/intelligence/digest?days=7").then((r) => r.json()),
      fetch("/api/knowledge/intelligence/actionable").then((r) => r.json()),
      fetch("/api/knowledge/intelligence/coverage").then((r) => r.json()),
    ]).then(([d, i, c]) => {
      setDigest(d);
      setInsights(i);
      setCoverage(c);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="text-center py-12 text-zinc-500">Loading intelligence...</div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Market Intelligence</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Proactive insights from your knowledge base
        </p>
      </div>

      {/* Digest */}
      {digest && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="text-3xl font-bold text-white">{digest.total_messages}</div>
            <div className="text-sm text-zinc-400">Messages (7 days)</div>
          </div>
          <div className="bg-blue-900/30 rounded-xl p-4 border border-blue-800/50">
            <div className="text-3xl font-bold text-blue-400">{digest.new_listings}</div>
            <div className="text-sm text-zinc-400">New Listings</div>
          </div>
          <div className="bg-green-900/30 rounded-xl p-4 border border-green-800/50">
            <div className="text-3xl font-bold text-green-400">{digest.new_requirements}</div>
            <div className="text-sm text-zinc-400">New Requirements</div>
          </div>
          <div className="bg-purple-900/30 rounded-xl p-4 border border-purple-800/50">
            <div className="text-3xl font-bold text-purple-400">{coverage?.total_markets || 0}</div>
            <div className="text-sm text-zinc-400">Active Markets</div>
          </div>
        </div>
      )}

      {/* Actionable Insights */}
      {insights.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Actionable Insights</h2>
          <div className="space-y-3">
            {insights.map((insight, i) => (
              <div
                key={i}
                className={`rounded-xl p-4 border ${
                  insight.priority === "high"
                    ? "bg-amber-900/20 border-amber-800/50"
                    : insight.priority === "medium"
                    ? "bg-blue-900/20 border-blue-800/50"
                    : "bg-zinc-800/50 border-zinc-700/50"
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{insight.title}</div>
                    <div className="text-sm text-zinc-400 mt-1">{insight.description}</div>
                  </div>
                  <span
                    className={`text-xs px-2 py-1 rounded ${
                      insight.priority === "high"
                        ? "bg-amber-800 text-amber-200"
                        : insight.priority === "medium"
                        ? "bg-blue-800 text-blue-200"
                        : "bg-zinc-700 text-zinc-300"
                    }`}
                  >
                    {insight.priority}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Market Coverage */}
      {coverage && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Market Coverage</h2>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-green-900/20 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-green-400">{coverage.balanced_markets}</div>
              <div className="text-xs text-zinc-400">Balanced</div>
            </div>
            <div className="bg-blue-900/20 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-blue-400">{coverage.supply_heavy}</div>
              <div className="text-xs text-zinc-400">Supply Heavy</div>
            </div>
            <div className="bg-amber-900/20 rounded-lg p-3 text-center">
              <div className="text-2xl font-bold text-amber-400">{coverage.demand_heavy}</div>
              <div className="text-xs text-zinc-400">Demand Heavy</div>
            </div>
          </div>
          <div className="bg-zinc-900 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left px-4 py-2 text-zinc-400">Market</th>
                  <th className="text-left px-4 py-2 text-zinc-400">Mentions</th>
                  <th className="text-left px-4 py-2 text-zinc-400">Status</th>
                </tr>
              </thead>
              <tbody>
                {coverage.markets.slice(0, 10).map((m, i) => (
                  <tr key={i} className="border-b border-zinc-800/50">
                    <td className="px-4 py-2">{m.market}</td>
                    <td className="px-4 py-2 text-zinc-400">{m.mentions}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          m.status === "balanced"
                            ? "bg-green-800 text-green-200"
                            : m.status === "supply_heavy"
                            ? "bg-blue-800 text-blue-200"
                            : m.status === "demand_heavy"
                            ? "bg-amber-800 text-amber-200"
                            : "bg-zinc-700 text-zinc-300"
                        }`}
                      >
                        {m.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Top Activity */}
      {digest && (
        <div className="grid grid-cols-2 gap-6">
          <div>
            <h2 className="text-lg font-semibold mb-3">Top Markets</h2>
            <div className="bg-zinc-900 rounded-xl p-4">
              {digest.top_markets.length === 0 ? (
                <div className="text-zinc-500 text-sm">No market data yet</div>
              ) : (
                <div className="space-y-2">
                  {digest.top_markets.map((m, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span>{m.market}</span>
                      <span className="text-zinc-400 text-sm">{m.count} mentions</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-3">Top Senders</h2>
            <div className="bg-zinc-900 rounded-xl p-4">
              {digest.top_senders.length === 0 ? (
                <div className="text-zinc-500 text-sm">No sender data yet</div>
              ) : (
                <div className="space-y-2">
                  {digest.top_senders.map((s, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span>{s.sender}</span>
                      <span className="text-zinc-400 text-sm">{s.count} messages</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
