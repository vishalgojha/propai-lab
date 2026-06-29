"use client";

import { useEffect, useState } from "react";

interface TrainerTerm {
  id: number;
  term: string;
  context: string;
  frequency: number;
  first_seen: string;
  last_seen: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

interface TrainerStats {
  total: number;
  pending: number;
  resolved: number;
  ignored: number;
  building: number;
  society: number;
  landmark: number;
  locality: number;
}

const STATUS_OPTIONS = [
  { value: "building", label: "Building", color: "blue" },
  { value: "society", label: "Society", color: "purple" },
  { value: "landmark", label: "Landmark", color: "amber" },
  { value: "locality", label: "Locality", color: "teal" },
  { value: "other", label: "Other", color: "slate" },
  { value: "ignored", label: "Ignore", color: "gray" },
];

export default function TrainerPage() {
  const [terms, setTerms] = useState<TrainerTerm[]>([]);
  const [stats, setStats] = useState<TrainerStats | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = async () => {
    setLoading(true);
    const [termsRes, statsRes] = await Promise.all([
      fetch(`/api/trainer/terms${filter ? `?status=${filter}` : ""}`).then(r => r.json()),
      fetch("/api/trainer/stats").then(r => r.json()),
    ]);
    setTerms(termsRes);
    setStats(statsRes);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filter]);

  const resolve = async (id: number, status: string) => {
    await fetch("/api/trainer/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ term_id: id, status }),
    });
    load();
  };

  const batchResolve = async (status: string) => {
    if (selected.size === 0) return;
    await fetch("/api/trainer/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: Array.from(selected).map(id => ({ term_id: id, status })) }),
    });
    setSelected(new Set());
    load();
  };

  const scan = async () => {
    setScanning(true);
    await fetch("/api/trainer/scan", { method: "POST" });
    setScanning(false);
    load();
  };

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pendingTerms = terms.filter(t => t.status === "pending");
  const resolvedTerms = terms.filter(t => t.status !== "pending" && t.status !== "ignored");

  return (
    <div className="max-w-5xl mx-auto p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Knowledge Trainer</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Identify unknown terms found in WhatsApp messages. Build PropAI's knowledge base.
          </p>
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="px-4 py-2 bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 disabled:opacity-50"
        >
          {scanning ? "Scanning..." : "Scan Messages"}
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-6 gap-3 mb-6">
          {[
            { label: "Total", value: stats.total, color: "bg-zinc-100 text-zinc-700" },
            { label: "Pending", value: stats.pending, color: "bg-amber-100 text-amber-700" },
            { label: "Buildings", value: stats.building || 0, color: "bg-blue-100 text-blue-700" },
            { label: "Societies", value: stats.society || 0, color: "bg-purple-100 text-purple-700" },
            { label: "Landmarks", value: stats.landmark || 0, color: "bg-teal-100 text-teal-700" },
            { label: "Ignored", value: stats.ignored || 0, color: "bg-gray-100 text-gray-500" },
          ].map(s => (
            <div key={s.label} className={`rounded-lg p-3 ${s.color}`}>
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-xs opacity-75">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 mb-4">
        {[null, "pending", "building", "society", "landmark", "locality", "ignored"].map(f => (
          <button
            key={f || "all"}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm ${filter === f ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
          >
            {f || "All"}
          </button>
        ))}
      </div>

      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-center justify-between">
          <span className="text-sm text-blue-700">{selected.size} selected</span>
          <div className="flex gap-2">
            {STATUS_OPTIONS.filter(s => s.value !== "ignored").map(s => (
              <button
                key={s.value}
                onClick={() => batchResolve(s.value)}
                className={`px-3 py-1 rounded text-xs text-white bg-${s.color}-500 hover:bg-${s.color}-600`}
              >
                → {s.label}
              </button>
            ))}
            <button
              onClick={() => batchResolve("ignored")}
              className="px-3 py-1 rounded text-xs bg-gray-200 text-gray-600 hover:bg-gray-300"
            >
              Ignore
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-zinc-500">Loading...</div>
      ) : terms.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-4xl mb-3">🔍</div>
          <h3 className="text-lg font-medium text-zinc-700 mb-1">No terms found</h3>
          <p className="text-sm text-zinc-500">
            Click "Scan Messages" to discover unknown building names
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {pendingTerms.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-zinc-500 mb-2">Pending Review ({pendingTerms.length})</h3>
              {pendingTerms.map(term => (
                <div key={term.id} className="bg-white border border-zinc-200 rounded-lg p-4 mb-2 hover:border-zinc-300">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(term.id)}
                        onChange={() => toggleSelect(term.id)}
                        className="w-4 h-4"
                      />
                      <div>
                        <div className="font-medium text-zinc-900">{term.term}</div>
                        <div className="text-xs text-zinc-500 mt-0.5">
                          {term.frequency}x in messages
                          {term.context && ` · "${term.context.slice(0, 60)}..."`}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      {STATUS_OPTIONS.filter(s => s.value !== "ignored").map(s => (
                        <button
                          key={s.value}
                          onClick={() => resolve(term.id, s.value)}
                          className={`px-2.5 py-1 rounded text-xs text-white bg-${s.color}-500 hover:bg-${s.color}-600`}
                        >
                          {s.label}
                        </button>
                      ))}
                      <button
                        onClick={() => resolve(term.id, "ignored")}
                        className="px-2.5 py-1 rounded text-xs bg-zinc-100 text-zinc-500 hover:bg-zinc-200"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {resolvedTerms.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-zinc-500 mb-2">Resolved ({resolvedTerms.length})</h3>
              {resolvedTerms.map(term => (
                <div key={term.id} className="bg-zinc-50 border border-zinc-200 rounded-lg p-3 mb-1.5 opacity-60">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(term.id)}
                        onChange={() => toggleSelect(term.id)}
                        className="w-4 h-4"
                      />
                      <span className="font-medium text-zinc-700">{term.term}</span>
                      <span className={`text-xs px-2 py-0.5 rounded bg-${STATUS_OPTIONS.find(s => s.value === term.status)?.color || "gray"}-100 text-${STATUS_OPTIONS.find(s => s.value === term.status)?.color || "gray"}-700`}>
                        {term.status}
                      </span>
                      <span className="text-xs text-zinc-400">{term.frequency}x</span>
                    </div>
                    <span className="text-xs text-zinc-400">
                      {term.resolved_at ? new Date(term.resolved_at).toLocaleDateString() : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
