"use client";

export const dynamic = 'force-dynamic';

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import * as api from "@/lib/api";
import { displayGroupName, resolveSenderName, displayPhone } from "@/lib/whatsapp-display";

function timeAgo(ts: string) {
  if (!ts) return "";
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function highlightSnippet(snippet: string) {
  return snippet.replace(/<mark>/g, '<mark class="bg-[#f0c000]/30 text-[#f0c000]">');
}

function SearchContent() {
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") || "";

  const [query, setQuery] = useState(initialQ);
  const [results, setResults] = useState<api.RawSearchResult[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      setCount(0);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const data = await api.searchRawMessages(q);
      setResults(data.results);
      setCount(data.count);
    } catch (e) {
      console.error("Search failed", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialQ) doSearch(initialQ);
  }, [initialQ, doSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(query);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-white">Knowledge Search</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Search across all raw messages — groups and DMs. Every message is remembered.
        </p>
      </div>

      {/* Search Box */}
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search buildings, brokers, locations, prices..."
          className="flex-1 px-4 py-3 bg-zinc-900 border border-white/10 rounded-xl text-white text-sm focus:border-[#58a6ff] focus:outline-none"
          autoFocus
        />
        <button
          type="submit"
          className="px-6 py-3 bg-[#58a6ff] text-white rounded-xl text-sm font-semibold hover:bg-[#4090e0]"
        >
          Search
        </button>
      </form>

      {/* Results */}
      {loading ? (
        <div className="text-center py-12 text-zinc-500">Searching...</div>
      ) : !searched ? (
        <div className="text-center py-12">
          <div className="text-zinc-500 text-sm">Enter a search query to find knowledge records</div>
          <div className="mt-4 flex flex-wrap gap-2 justify-center">
            {["Parijat", "2 BHK Bandra", "Raju", "Lokhandwala", "Chandak Unicorn"].map((q) => (
              <button
                key={q}
                onClick={() => { setQuery(q); doSearch(q); }}
                className="px-3 py-1.5 bg-zinc-800 border border-white/10 rounded-lg text-xs text-zinc-400 hover:text-white"
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      ) : results.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">No results found</div>
      ) : (
        <div className="space-y-3">
          <div className="text-xs text-zinc-500">{count.toLocaleString()} results found</div>

          {results.map((r) => (
            <div
              key={r.id}
              className="bg-zinc-900 border border-white/10 rounded-xl p-4 hover:border-[rgba(88,166,255,0.3)] transition-colors"
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 bg-zinc-800 border border-white/10 rounded text-[10px] text-zinc-400">
                    {displayGroupName(r.group_name) || "Direct Message"}
                  </span>
                  <span className="text-[10px] text-zinc-500">{resolveSenderName(r)}</span>
                </div>
                <span className="text-[10px] text-zinc-500">{timeAgo(r.timestamp)}</span>
              </div>

              {/* Snippet */}
              <div
                className="text-xs text-white leading-relaxed"
                dangerouslySetInnerHTML={{ __html: highlightSnippet(r.snippet) }}
              />

              {/* Footer */}
              <div className="flex items-center gap-4 mt-2 text-[10px] text-zinc-500">
                {r.sender_phone && <span>📞 {displayPhone(r.sender_phone)}</span>}
                <span>ID: {r.id}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="text-center text-zinc-500 py-16">Loading...</div>}>
      <SearchContent />
    </Suspense>
  );
}
