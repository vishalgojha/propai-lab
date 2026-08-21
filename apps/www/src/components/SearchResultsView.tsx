"use client";

import { useState } from "react";
import { List, Map } from "lucide-react";
import type { NaturalSearchResult } from "@/lib/natural-search";
import { toListingCardViewModel } from "@/lib/listing-card";
import ListingTile from "@/components/ListingTile";
import SearchMapLoader from "@/components/SearchMapLoader";

export default function SearchResultsView({
  results,
  googleMapsApiKey,
}: {
  results: NaturalSearchResult[];
  googleMapsApiKey: string | null;
}) {
  const [view, setView] = useState<"list" | "map">("list");
  const geocodedCount = results.filter(
    (r) => r.latitude != null && r.longitude != null,
  ).length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-0.5">
          <button
            onClick={() => setView("list")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "list"
                ? "bg-[var(--accent-primary)] text-[#FAF7F0]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            Grid
          </button>
          <button
            onClick={() => setView("map")}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "map"
                ? "bg-[var(--accent-primary)] text-[#FAF7F0]"
                : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Map className="h-3.5 w-3.5" />
            Map
            {geocodedCount > 0 && (
              <span className="text-[10px] opacity-75">({geocodedCount})</span>
            )}
          </button>
        </div>
        {view === "map" && geocodedCount === 0 && (
          <span className="text-xs text-[var(--text-secondary)]">No results with coordinates</span>
        )}
      </div>

      {view === "list" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:gap-5">
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
        <SearchMapLoader results={results} apiKey={googleMapsApiKey} />
      )}
    </div>
  );
}
