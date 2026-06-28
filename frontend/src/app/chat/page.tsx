"use client";

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";

interface Suggestion {
  id: number;
  agent: string;
  suggestion_type: string;
  title: string;
  description: string;
  source_data: any;
  proposal_data: any;
  confidence: number;
  status: string;
  created_at: string;
}

const AGENT_ICONS: Record<string, string> = {
  duplicate_listing: "🔄",
  merge_broker: "👤",
  alias: "🏷️",
  location: "📍",
  building: "🏢",
  price: "💰",
  quality: "✅",
  requirement: "📋",
};

const AGENT_LABELS: Record<string, string> = {
  duplicate_listing: "Duplicate",
  merge_broker: "Merge",
  alias: "Alias",
  location: "Location",
  building: "Building",
  price: "Price",
  quality: "Quality",
  requirement: "Requirement",
};

export default function AIReviewPage() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sugs, c] = await Promise.all([
        api.getSuggestions(filter),
        api.getSuggestionCounts(),
      ]);
      setSuggestions(sugs);
      setCounts(c);
    } catch {
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  async function act(id: number, action: string) {
    setActionId(id);
    try {
      await api.actOnSuggestion(id, action);
      await load();
    } catch {
    } finally {
      setActionId(null);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">AI Review</h1>
          <p className="text-xs text-[#94a3b8]">
            {counts.pending || 0} pending suggestion{(counts.pending || 0) !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex gap-1 text-xs">
          {["pending", "approved", "rejected", "ignored", "all"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-2.5 py-1.5 rounded-lg font-medium capitalize ${
                filter === s
                  ? "bg-blue-600 text-white"
                  : "text-[#94a3b8] hover:text-white"
              }`}
            >
              {s} {counts[s] != null ? `(${counts[s]})` : ""}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-center text-[#64748b] py-16">Loading...</div>
      ) : suggestions.length === 0 ? (
        <div className="text-center text-[#64748b] py-16">
          No {filter === "all" ? "" : filter} suggestions
        </div>
      ) : (
        <div className="space-y-3">
          {suggestions.map((s) => (
            <div
              key={s.id}
              className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4"
            >
              <div className="flex items-start gap-3">
                <span className="text-lg mt-0.5">
                  {AGENT_ICONS[s.agent] || "🤖"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                      {AGENT_LABELS[s.agent] || s.agent}
                    </span>
                    {s.confidence > 0 && (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          s.confidence >= 0.8
                            ? "text-green-400 bg-green-500/10"
                            : s.confidence >= 0.5
                              ? "text-yellow-400 bg-yellow-500/10"
                              : "text-red-400 bg-red-500/10"
                        }`}
                      >
                        {Math.round(s.confidence * 100)}%
                      </span>
                    )}
                    <span className="text-[10px] text-[#64748b] ml-auto">
                      {new Date(s.created_at).toLocaleString("en-IN", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <h3 className="text-sm font-semibold mb-0.5">{s.title}</h3>
                  {s.description && (
                    <p className="text-xs text-[#94a3b8] whitespace-pre-wrap">{s.description}</p>
                  )}
                </div>
              </div>

              {s.status === "pending" && (
                <div className="flex gap-2 mt-3 ml-8">
                  <button
                    onClick={() => act(s.id, "approve")}
                    disabled={actionId === s.id}
                    className="px-3 py-1.5 text-xs font-medium bg-green-600 hover:bg-green-500 disabled:opacity-40 rounded-lg"
                  >
                    {actionId === s.id ? "..." : "Approve"}
                  </button>
                  <button
                    onClick={() => act(s.id, "reject")}
                    disabled={actionId === s.id}
                    className="px-3 py-1.5 text-xs font-medium bg-red-600/60 hover:bg-red-500 disabled:opacity-40 rounded-lg"
                  >
                    Reject
                  </button>
                  <button
                    onClick={() => act(s.id, "ignore")}
                    disabled={actionId === s.id}
                    className="px-3 py-1.5 text-xs font-medium text-[#64748b] hover:text-white border border-[rgba(255,255,255,0.1)] rounded-lg"
                  >
                    Ignore
                  </button>
                </div>
              )}

              {s.status !== "pending" && (
                <div className="mt-3 ml-8">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded ${
                      s.status === "approved"
                        ? "text-green-400 bg-green-500/10"
                        : s.status === "rejected"
                          ? "text-red-400 bg-red-500/10"
                          : "text-[#64748b] bg-[rgba(255,255,255,0.04)]"
                    }`}
                  >
                    {s.status.charAt(0).toUpperCase() + s.status.slice(1)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
