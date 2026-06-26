"use client";

import { useState, useEffect } from "react";
import * as api from "@/lib/api";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<any[] | null>(null);

  async function handleSearch() {
    if (!query.trim()) return;
    setResults(null);
    try {
      const data = await api.searchMessages(query);
      setResults(data);
    } catch (e: any) {
      setResults([]);
    }
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Search</h2>
      <div className="flex gap-2 mb-6">
        <input
          type="text"
          placeholder='e.g. "2 bhk bandra west under 3cr", "lodha owner listings"...'
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          className="flex-1 px-3 py-2 bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm text-[#e2e8f0]"
        />
        <button onClick={handleSearch} className="px-4 py-2 bg-[#3EE88A] text-[#04100a] rounded-lg text-sm font-bold">Search</button>
      </div>

      {results === null ? (
        <div className="text-[#64748b] text-center py-10">Search over structured real estate data.</div>
      ) : results.length === 0 ? (
        <div className="text-[#64748b] text-center py-10">No results found.</div>
      ) : (
        <div className="space-y-3">
          {results.map((r, i) => (
            <div key={i} className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-4">
              <div className="flex gap-2 items-center mb-1 flex-wrap">
                {r.intent && <span className="badge badge-blue">{r.intent}</span>}
                {r.broker_name && <span className="text-sm font-semibold">{r.broker_name}</span>}
                {r.bhk && <span className="text-sm text-[#64748b]">{r.bhk}</span>}
                {r.price && <span className="text-sm text-[#64748b]">₹{Number(r.price).toLocaleString()}</span>}
                {r.micro_market && <span className="text-sm text-[#64748b]">{r.micro_market}</span>}
              </div>
              <div className="text-sm">{r.message}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
