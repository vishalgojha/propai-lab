"use client";

import { useState } from "react";
import { List, Map } from "lucide-react";
import type { NaturalSearchResult } from "@/lib/natural-search";
import { toListingCardViewModel } from "@/lib/listing-card";
import ListingTile from "@/components/ListingTile";
import SearchMapLoader from "@/components/SearchMapLoader";

export default function SearchResultsView({
  results,
  mapToken,
}: {
  results: NaturalSearchResult[];
  mapToken: string | null;
}) {
  const [view, setView] = useState<"list" | "map">("list");
  const geocodedCount = results.filter(
    (r) => r.latitude != null && r.longitude != null,
  ).length;

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <div className="inline-flex rounded-lg border border-white/10 bg-zinc-900/70 p-0.5">
          <button
            onClick={() => setView("list")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "list"
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            Grid
          </button>
          <button
            onClick={() => setView("map")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "map"
                ? "bg-zinc-700 text-white"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            <Map className="h-3.5 w-3.5" />
            Map
            {geocodedCount > 0 && (
              <span className="text-[10px] text-zinc-500">({geocodedCount})</span>
            )}
          </button>
        </div>
        {view === "map" && geocodedCount === 0 && (
          <span className="text-xs text-zinc-500">No results with coordinates</span>
        )}
      </div>

      {view === "list" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-7">
          {results.map((row) => {
            const card = toListingCardViewModel(row, row.resultType === "building");
            return (
            <ListingTile
              key={row.id}
              card={card}
              buildingName={row.building_name}
              footerNote={
                row.matchedOn.length > 0
                  ? `Matched on: ${row.matchedOn.join(", ")}`
                  : null
              }
            />
            );
          })}
        </div>
      ) : (
        <SearchMapLoader results={results} token={mapToken} />
      )}
    </div>
  );
}
