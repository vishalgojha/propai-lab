"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { fetchJSON } from "@/lib/api";

interface KnowledgeRecord {
  id: number;
  source_type: string;
  raw_content: string;
  sender_name: string;
  sender_phone: string;
  conversation_name: string;
  message_timestamp?: string;
  timestamp?: string;
  content_type: string;
  intent: string;
  confidence: number;
}

interface Stats {
  total_records: number;
  unique_senders: number;
  unique_conversations: number;
  listings: number;
  requirements: number;
  unclassified: number;
}

export default function KnowledgePage() {
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KnowledgeRecord | null>(null);
  const safeStats: Stats = {
    total_records: stats?.total_records ?? 0,
    unique_senders: stats?.unique_senders ?? 0,
    unique_conversations: stats?.unique_conversations ?? 0,
    listings: stats?.listings ?? 0,
    requirements: stats?.requirements ?? 0,
    unclassified: stats?.unclassified ?? 0,
  };

  useEffect(() => {
    Promise.all([
      fetchJSON<KnowledgeRecord[]>("/knowledge/records?limit=100"),
      fetchJSON<Stats>("/knowledge/stats"),
    ]).then(([r, s]) => {
      setRecords(r);
      setStats(s);
      setLoading(false);
    });
  }, []);

  const handleSearch = async () => {
    if (!search.trim()) {
      const data = await fetchJSON<KnowledgeRecord[]>("/knowledge/records?limit=100");
      setRecords(data);
      return;
    }
    const data = await fetchJSON<KnowledgeRecord[]>(`/knowledge/search?q=${encodeURIComponent(search)}&limit=50`);
    setRecords(data);
  };

  const handleFilter = async (f: string) => {
    setFilter(f);
    const url = f === "all"
      ? "/knowledge/records?limit=100"
      : `/knowledge/records?limit=100&content_type=${f}`;
    const data = await fetchJSON<KnowledgeRecord[]>(url);
    setRecords(data);
  };

  const getIntentColor = (intent: string) => {
    switch (intent) {
      case "SELL": return "bg-blue-800 text-blue-200";
      case "RENT": return "bg-green-800 text-green-200";
      case "BUY": return "bg-amber-800 text-amber-200";
      case "RENTAL_SEEKER": return "bg-purple-800 text-purple-200";
      default: return "bg-zinc-700 text-zinc-300";
    }
  };

  const getTypeColor = (type: string) => {
    switch (type) {
      case "listing": return "bg-blue-900/30 border-blue-800/50";
      case "requirement": return "bg-green-900/30 border-green-800/50";
      case "social": return "bg-zinc-800/50 border-zinc-700/50";
      case "inquiry": return "bg-amber-900/30 border-amber-800/50";
      default: return "bg-zinc-900 border-zinc-800";
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div className="text-center py-12 text-zinc-500">Loading knowledge base...</div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Knowledge Base</h1>
        <p className="text-sm text-zinc-500 mt-1">
          {safeStats.total_records.toLocaleString()} records from WhatsApp messages
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-6 gap-3 mb-6">
          {[
            { label: "Total", value: safeStats.total_records, color: "bg-zinc-100 text-zinc-700" },
            { label: "Listings", value: safeStats.listings, color: "bg-blue-100 text-blue-700" },
            { label: "Requirements", value: safeStats.requirements, color: "bg-green-100 text-green-700" },
            { label: "Senders", value: safeStats.unique_senders, color: "bg-purple-100 text-purple-700" },
            { label: "Conversations", value: safeStats.unique_conversations, color: "bg-amber-100 text-amber-700" },
            { label: "Unclassified", value: safeStats.unclassified, color: "bg-red-100 text-red-700" },
          ].map((s) => (
            <div key={s.label} className={`rounded-lg p-3 ${s.color}`}>
              <div className="text-2xl font-bold">{s.value.toLocaleString()}</div>
              <div className="text-xs opacity-75">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Search & Filters */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="Search knowledge records..."
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-zinc-500"
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700"
        >
          Search
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {["all", "listing", "requirement", "inquiry", "social", "unknown"].map((f) => (
          <button
            key={f}
            onClick={() => handleFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              filter === f ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
            }`}
          >
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Records */}
      <div className="space-y-2">
        {records.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">No records found</div>
        ) : (
          records.map((record) => (
            <div
              key={record.id}
              onClick={() => setSelected(record)}
              className={`border rounded-lg p-4 cursor-pointer hover:border-zinc-500 ${getTypeColor(record.content_type)}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-zinc-400">#{record.id}</span>
                    <span className="text-xs text-zinc-500">{record.source_type}</span>
                    {record.intent && record.intent !== "NONE" && (
                      <span className={`text-xs px-2 py-0.5 rounded ${getIntentColor(record.intent)}`}>
                        {record.intent}
                      </span>
                    )}
                  </div>
                  <div className="text-sm line-clamp-2">{record.raw_content}</div>
                  <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
                    <span>{record.sender_name || "Unknown"}</span>
                    <span>{record.conversation_name}</span>
                    <span>{(record.message_timestamp || record.timestamp)?.split("T")[0]}</span>
                  </div>
                </div>
                <div className="text-right text-xs text-zinc-500">
                  {Math.round(record.confidence * 100)}%
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 rounded-xl max-w-2xl w-full max-h-[80vh] overflow-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Record #{selected.id}</h2>
              <button
                onClick={() => setSelected(null)}
                className="text-zinc-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Content</div>
                <div className="bg-zinc-800 rounded-lg p-3 text-sm whitespace-pre-wrap">
                  {selected.raw_content}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Source</div>
                  <div className="text-sm">{selected.source_type}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Type</div>
                  <div className="text-sm">{selected.content_type}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Intent</div>
                  <div className="text-sm">{selected.intent}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Confidence</div>
                  <div className="text-sm">{Math.round(selected.confidence * 100)}%</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Sender</div>
                  <div className="text-sm">{selected.sender_name || "Unknown"}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Phone</div>
                  <div className="text-sm">{selected.sender_phone || "Unknown"}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Conversation</div>
                  <div className="text-sm">{selected.conversation_name}</div>
                </div>
                <div>
                  <div className="text-xs text-zinc-400 mb-1">Timestamp</div>
                  <div className="text-sm">{selected.message_timestamp || selected.timestamp}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
