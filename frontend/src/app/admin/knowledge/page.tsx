"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import Link from "next/link";
import { Search, Filter, Database, Eye, Download, Upload, Trash2, RotateCcw } from "lucide-react";

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

export default function AdminKnowledgePage() {
  const [records, setRecords] = useState<KnowledgeRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<KnowledgeRecord | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const safeStats: Stats = {
    total_records: stats?.total_records ?? 0,
    unique_senders: stats?.unique_senders ?? 0,
    unique_conversations: stats?.unique_conversations ?? 0,
    listings: stats?.listings ?? 0,
    requirements: stats?.requirements ?? 0,
    unclassified: stats?.unclassified ?? 0,
  };

  const fetchRecords = async () => {
    const params = new URLSearchParams();
    params.set("limit", PAGE_SIZE.toString());
    params.set("offset", ((page - 1) * PAGE_SIZE).toString());
    if (search.trim()) params.set("q", search.trim());
    if (filter !== "all") params.set("content_type", filter);

    const res = await fetch(`/api/knowledge/records?${params.toString()}`);
    const data = await res.json();
    setRecords(data);
  };

  const fetchStats = async () => {
    const res = await fetch("/api/knowledge/stats");
    setStats(await res.json());
  };

  useEffect(() => {
    Promise.all([fetchRecords(), fetchStats()]).then(() => setLoading(false));
  }, [search, filter, page]);

  const handleSearch = () => { setPage(1); fetchRecords(); };

  const handleFilter = (f: string) => { setFilter(f); setPage(1); fetchRecords(); };

  const getIntentColor = (intent: string) => {
    switch (intent) {
      case "SELL": return "bg-blue-800 text-blue-200";
      case "RENT": return "bg-green-800 text-green-200";
      case "BUY": return "bg-amber-800 text-amber-200";
      case "RENTAL_SEEKER": return "bg-purple-800 text-purple-200";
      default: return "bg-zinc-700 text-zinc-300";
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-center py-12 text-zinc-500">Loading knowledge base…</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <Link href="/admin" className="text-sm text-zinc-400 hover:text-zinc-200 mb-2 inline-block">← Admin</Link>
          <h1 className="text-2xl font-bold">Knowledge Records</h1>
          <p className="text-sm text-zinc-500 mt-1">
            {safeStats.total_records.toLocaleString()} records from WhatsApp messages
          </p>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-1.5 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 text-sm flex items-center gap-1.5">
            <RotateCcw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: "Total", value: safeStats.total_records },
            { label: "Listings", value: safeStats.listings },
            { label: "Requirements", value: safeStats.requirements },
            { label: "Senders", value: safeStats.unique_senders },
            { label: "Conversations", value: safeStats.unique_conversations },
            { label: "Unclassified", value: safeStats.unclassified },
          ].map((s) => (
            <Link key={s.label} href={`/admin/knowledge?filter=${s.label.toLowerCase()}`} className="rounded-lg p-3 hover:bg-white/[0.02] transition-colors">
              <div className="text-2xl font-bold text-white">{s.value.toLocaleString()}</div>
              <div className="text-xs text-zinc-400">{s.label}</div>
            </Link>
          ))}
        </div>
      )}

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="Search knowledge records…"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg pl-10 pr-4 py-2 text-sm focus:outline-none focus:border-zinc-500"
          />
        </div>
        <div className="flex gap-2">
          {["all", "listing", "requirement", "inquiry", "social", "unknown"].map((f) => (
            <button
              key={f}
              onClick={() => handleFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                filter === f ? "bg-zinc-900 text-white border border-zinc-600" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Records */}
      <div className="space-y-2">
        {records.length === 0 ? (
          <div className="text-center py-12 text-zinc-500">
            <Database className="w-12 h-12 mx-auto text-zinc-600 mb-2" />
            <div>No records found</div>
            <div className="text-xs text-zinc-500 mt-1">Try adjusting your search or filters</div>
          </div>
        ) : (
          <>
            {records.map((record) => (
              <div
                key={record.id}
                onClick={() => setSelected(record)}
                className="border-b border-white/[0.04] last:border-0 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
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
            ))}
          </>
        )}

        {/* Pagination */}
        {records.length === PAGE_SIZE && (
          <div className="flex justify-center gap-2 mt-4">
            <button
              onClick={() => { if (page > 1) { setPage(p => p - 1); fetchRecords(); }}}
              disabled={page === 1}
              className="px-3 py-1.5 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-50 text-sm"
            >
              Previous
            </button>
            <span className="flex items-center px-3 text-sm text-zinc-400">Page {page}</span>
            <button
              onClick={() => { setPage(p => p + 1); fetchRecords(); }}
              className="px-3 py-1.5 bg-zinc-800 text-white rounded-lg hover:bg-zinc-700 text-sm"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Detail Modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="rounded-xl border border-white/10 max-w-2xl w-full max-h-[80vh] overflow-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Record #{selected.id}</h2>
              <button onClick={() => setSelected(null)} className="text-zinc-400 hover:text-white">✕</button>
            </div>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">Content</div>
                <div className="rounded-lg border border-white/10 p-3 text-sm whitespace-pre-wrap">{selected.raw_content}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><div className="text-xs text-zinc-400 mb-1">Source</div><div className="text-sm">{selected.source_type}</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Type</div><div className="text-sm">{selected.content_type}</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Intent</div><div className="text-sm">{selected.intent}</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Confidence</div><div className="text-sm">{Math.round(selected.confidence * 100)}%</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Sender</div><div className="text-sm">{selected.sender_name || "Unknown"}</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Phone</div><div className="text-sm">{selected.sender_phone || "Unknown"}</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Conversation</div><div className="text-sm">{selected.conversation_name}</div></div>
                <div><div className="text-xs text-zinc-400 mb-1">Timestamp</div><div className="text-sm">{selected.message_timestamp || selected.timestamp}</div></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
