"use client";

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";

function confidenceColor(c: number) {
  if (c >= 0.9) return "text-[#3EE88A]";
  if (c >= 0.7) return "text-[#f0c000]";
  return "text-[#ff6b35]";
}

function confidenceBadge(c: number) {
  if (c >= 0.9) return "bg-[#3EE88A]/20 text-[#3EE88A]";
  if (c >= 0.7) return "bg-[#f0c000]/20 text-[#f0c000]";
  return "bg-[#ff6b35]/20 text-[#ff6b35]";
}

export default function AliasSuggestionsPage() {
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [stats, setStats] = useState<{
    total_suggestions: number;
    pending: number;
    approved: number;
    rejected: number;
    aliases_in_kb: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected">("pending");
  const [discovering, setDiscovering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sugData, statsData] = await Promise.all([
        api.getAliasSuggestions(filter),
        api.getAliasStats(),
      ]);
      setSuggestions(sugData.suggestions);
      setStats(statsData);
    } catch (e) {
      console.error("Failed to load alias suggestions", e);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const handleReview = async (id: number, approved: boolean) => {
    try {
      await api.reviewAliasSuggestion(id, approved);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
      setStats((prev) => prev ? {
        ...prev,
        pending: prev.pending - 1,
        [approved ? "approved" : "rejected"]: (prev[approved ? "approved" : "rejected"] || 0) + 1,
      } : null);
    } catch (e) {
      console.error("Failed to review suggestion", e);
    }
  };

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      await api.discoverBuildingAliases();
      load();
    } catch (e) {
      console.error("Failed to discover aliases", e);
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#e2e8f0]">Building Alias Engine</h1>
        <p className="text-sm text-[#64748b] mt-1">
          Learn building aliases from broker messages. Review and approve merges to improve your Building KB.
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Total Discovered</div>
            <div className="text-2xl font-bold text-[#e2e8f0]">{stats.total_suggestions}</div>
          </div>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Pending Review</div>
            <div className="text-2xl font-bold text-[#f0c000]">{stats.pending}</div>
          </div>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Approved</div>
            <div className="text-2xl font-bold text-[#3EE88A]">{stats.approved}</div>
          </div>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Rejected</div>
            <div className="text-2xl font-bold text-[#ff6b35]">{stats.rejected}</div>
          </div>
          <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Aliases in KB</div>
            <div className="text-2xl font-bold text-[#58a6ff]">{stats.aliases_in_kb}</div>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleDiscover}
          disabled={discovering}
          className="px-4 py-2 bg-[#58a6ff] text-white rounded-lg text-sm font-semibold disabled:opacity-50"
        >
          {discovering ? "Discovering..." : "Discover New Aliases"}
        </button>

        <div className="flex gap-1 border border-[rgba(255,255,255,0.1)] rounded-lg overflow-hidden">
          {(["pending", "approved", "rejected"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                filter === f
                  ? "bg-[#58a6ff] text-white"
                  : "text-[#64748b] hover:text-white"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <span className="text-xs text-[#64748b]">{suggestions.length} suggestions</span>
      </div>

      {/* Suggestions List */}
      {loading ? (
        <div className="text-center py-12 text-[#64748b]">Loading...</div>
      ) : suggestions.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-[#64748b] text-sm">No {filter} suggestions</div>
          {filter === "pending" && (
            <button
              onClick={handleDiscover}
              className="mt-3 px-4 py-2 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm text-[#64748b] hover:text-white"
            >
              Discover Aliases
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {suggestions.map((s) => (
            <div
              key={s.id}
              className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 hover:border-[rgba(88,166,255,0.3)] transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                {/* Left: Names */}
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <div>
                      <div className="text-[10px] text-[#64748b] uppercase tracking-wider">Canonical</div>
                      <div className="text-sm font-bold text-[#e2e8f0]">{s.canonical}</div>
                    </div>
                    <span className="text-[#64748b] text-lg">↔</span>
                    <div>
                      <div className="text-[10px] text-[#64748b] uppercase tracking-wider">Alias</div>
                      <div className="text-sm font-bold text-[#e2e8f0]">{s.alias}</div>
                    </div>
                  </div>

                  {/* Confidence */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${confidenceBadge(s.confidence)}`}>
                      {(s.confidence * 100).toFixed(0)}% confidence
                    </span>
                    <span className="text-[10px] text-[#64748b]">Source: {s.source}</span>
                  </div>

                  {/* Reasons */}
                  {s.reasons && s.reasons.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {s.reasons.map((r: string, i: number) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 bg-[#111820] border border-[rgba(255,255,255,0.06)] rounded text-[10px] text-[#94a3b8]"
                        >
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right: Actions */}
                {filter === "pending" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleReview(s.id, true)}
                      className="px-3 py-1.5 bg-[#3EE88A] text-[#04100a] rounded-lg text-xs font-bold hover:bg-[#2dd67a]"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReview(s.id, false)}
                      className="px-3 py-1.5 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-xs font-semibold text-[#64748b] hover:text-white"
                    >
                      Reject
                    </button>
                  </div>
                )}

                {filter === "approved" && (
                  <span className="px-2 py-1 bg-[#3EE88A]/20 text-[#3EE88A] rounded text-[10px] font-bold">
                    ✓ Approved
                  </span>
                )}

                {filter === "rejected" && (
                  <span className="px-2 py-1 bg-[#ff6b35]/20 text-[#ff6b35] rounded text-[10px] font-bold">
                    ✗ Rejected
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
