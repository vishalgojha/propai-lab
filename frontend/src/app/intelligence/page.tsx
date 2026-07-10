"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const REQUEST_TIMEOUT_MS = 8000;

interface Digest {
  period: string;
  total_messages: number;
  new_listings: number;
  new_requirements: number;
  top_markets: { market: string; count: number }[];
  top_buildings: { building: string; count: number }[];
}

interface Insight {
  type: string;
  title: string;
  description: string;
  action: string;
  priority: string;
}

interface DisplayInsight extends Insight {
  displayTitle: string;
  displayDescription: string;
  cta: string;
  href: string;
}

interface Coverage {
  total_markets: number;
  balanced_markets: number;
  supply_heavy: number;
  demand_heavy: number;
  markets: { market: string; mentions: number; status: string }[];
}

const emptyDigest: Digest = {
  period: "Last 7 day(s)",
  total_messages: 0,
  new_listings: 0,
  new_requirements: 0,
  top_markets: [],
  top_buildings: [],
};

const emptyCoverage: Coverage = {
  total_markets: 0,
  balanced_markets: 0,
  supply_heavy: 0,
  demand_heavy: 0,
  markets: [],
};

async function fetchJSON<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    window.clearTimeout(timeout);
  }
}

function isMaskedIdentifier(value: string) {
  return /^\+\d/.test(value || "") || /X{3,}/i.test(value || "");
}

function cleanQuietSourceName(title: string) {
  const name = title.split(" hasn't posted")[0]?.trim() || "";
  return isMaskedIdentifier(name) ? "" : name;
}

function displayInsight(insight: Insight): DisplayInsight {
  if (insight.type === "opportunity") {
    return {
      ...insight,
      displayTitle: insight.title,
      displayDescription: "Demand signals are captured from WhatsApp groups. Review the source conversations before acting.",
      cta: "Open market inbox",
      href: "/inbox",
    };
  }

  if (insight.type === "market_gap") {
    const market = insight.title.split(":")[0] || "";
    return {
      ...insight,
      displayTitle: insight.title,
      displayDescription: insight.description,
      cta: "Open market",
      href: `/market?q=${encodeURIComponent(market)}`,
    };
  }

  if (insight.type === "relationship") {
    const sourceName = cleanQuietSourceName(insight.title);
    const query = sourceName || insight.title.split(" hasn't posted")[0] || "broker";
    return {
      ...insight,
      displayTitle: sourceName ? `Quiet source: ${sourceName}` : "Quiet source from your WhatsApp network",
      displayDescription: "This source was previously active. Review their last messages before deciding whether a follow-up is worth it.",
      cta: "Review activity",
      href: `/search?q=${encodeURIComponent(query)}`,
    };
  }

  return {
    ...insight,
    displayTitle: insight.title,
    displayDescription: insight.description,
    cta: insight.action || "Review",
    href: "/search",
  };
}

export default function IntelligencePage() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetchJSON<Digest>("/api/knowledge/intelligence/digest?days=7"),
      fetchJSON<Insight[]>("/api/knowledge/intelligence/actionable"),
      fetchJSON<Coverage>("/api/knowledge/intelligence/coverage"),
    ])
      .then(([d, i, c]) => {
        setDigest({ ...emptyDigest, ...d });
        setInsights(Array.isArray(i) ? i : []);
        setCoverage({ ...emptyCoverage, ...c });
      })
      .catch((err: unknown) => {
        setDigest(emptyDigest);
        setInsights([]);
        setCoverage(emptyCoverage);
        setError(err instanceof Error ? err.message : "Could not load market actions");
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="text-center py-12 text-zinc-500">Loading market actions...</div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Market Actions</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Work queues created from captured WhatsApp knowledge.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-red-900/60 bg-red-950/30 p-4">
          <div className="font-medium text-red-200">Market actions could not load</div>
          <div className="mt-1 text-sm text-red-200/70">{error}</div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-950 hover:bg-white"
          >
            Retry
          </button>
        </div>
      )}

      {/* Digest */}
      {digest && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="bg-zinc-900 rounded-xl p-4">
            <div className="text-3xl font-bold text-white">{digest.total_messages.toLocaleString()}</div>
            <div className="text-sm text-zinc-400">Captured Messages</div>
          </div>
          <div className="bg-blue-900/30 rounded-xl p-4 border border-blue-800/50">
            <div className="text-3xl font-bold text-blue-400">{digest.new_listings.toLocaleString()}</div>
            <div className="text-sm text-zinc-400">Supply Candidates</div>
          </div>
          <div className="bg-green-900/30 rounded-xl p-4 border border-green-800/50">
            <div className="text-3xl font-bold text-green-400">{digest.new_requirements.toLocaleString()}</div>
            <div className="text-sm text-zinc-400">Demand Candidates</div>
          </div>
          <div className="bg-purple-900/30 rounded-xl p-4 border border-purple-800/50">
            <div className="text-3xl font-bold text-purple-400">{coverage?.total_markets.toLocaleString() || 0}</div>
            <div className="text-sm text-zinc-400">Markets Covered</div>
          </div>
        </div>
      )}

      {/* Actionable Insights */}
      {insights.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Actionable Insights</h2>
          <div className="space-y-3">
            {insights.map((rawInsight, i) => {
              const insight = displayInsight(rawInsight);
              return (
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
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-medium">{insight.displayTitle}</div>
                    <div className="text-sm text-zinc-400 mt-1">{insight.displayDescription}</div>
                    <Link
                      href={insight.href}
                      className="inline-flex mt-3 px-3 py-1.5 rounded-lg bg-zinc-100 text-zinc-950 text-xs font-semibold hover:bg-white"
                    >
                      {insight.cta}
                    </Link>
                  </div>
                  <span
                    className={`shrink-0 text-xs px-2 py-1 rounded ${
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
              );
            })}
          </div>
        </div>
      )}

      {/* Market Coverage */}
      {coverage && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-3">Supply vs Demand Coverage</h2>
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
        <div>
          <div>
            <h2 className="text-lg font-semibold mb-3">Strongest Markets</h2>
            <div className="bg-zinc-900 rounded-xl p-4">
              {digest.top_markets.length === 0 ? (
                <div className="text-zinc-500 text-sm">No market data yet</div>
              ) : (
                <div className="space-y-2">
                  {digest.top_markets.map((m, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <span>{m.market}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-zinc-400 text-sm">{m.count.toLocaleString()} mentions</span>
                        <Link
                          href={`/market?q=${encodeURIComponent(m.market)}`}
                          className="text-xs font-medium text-blue-300 hover:text-blue-200"
                        >
                          Open
                        </Link>
                      </div>
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
