"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { BuildingOnMap } from "@/lib/localities";
import ListingCard from "@/components/ListingCard";

export default function BuildingsExplorer({ buildings }: { buildings: BuildingOnMap[] }) {
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(60);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? buildings.filter((b) => b.name.toLowerCase().includes(q))
      : buildings;
    return [...list].sort((a, b) => (b.listingCount ?? 0) - (a.listingCount ?? 0));
  }, [query, buildings]);

  const shown = filtered.slice(0, visible);

  return (
    <div>
      <div className="relative mb-8 max-w-xl">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setVisible(60);
          }}
          placeholder="Search buildings by name…"
          className="w-full rounded-xl border border-white/10 bg-zinc-900/60 pl-10 pr-4 py-3 text-sm text-white placeholder:text-zinc-500 focus:border-green-400/50 focus:outline-none"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-zinc-400">No buildings match “{query}”.</p>
      ) : (
        <>
          <p className="text-sm text-zinc-500 mb-4">
            {filtered.length} building{filtered.length === 1 ? "" : "s"}
            {query ? " matching your search" : " — sorted by listing activity"}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
            {shown.map((b) => (
              <ListingCard key={b.name} building={b} />
            ))}
          </div>

          {visible < filtered.length && (
            <div className="text-center mt-10">
              <button
                type="button"
                onClick={() => setVisible((v) => v + 60)}
                className="inline-flex items-center gap-2 px-6 py-3 bg-zinc-800 border border-white/10 text-white text-sm font-semibold rounded-lg hover:bg-zinc-700 transition-colors"
              >
                Show more ({filtered.length - visible} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
