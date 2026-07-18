"use client";

import { useState } from "react";
import Link from "next/link";
import SearchBox from "@/components/SearchBox";
import ListingTile from "@/components/ListingTile";
import type { LocalitySummary } from "@/lib/localities";
import type { ListingCardViewModel } from "@/lib/listing-card";
import { useAnalytics } from "@/lib/useAnalytics";

type ResultItem = {
  card: ListingCardViewModel;
  buildingName: string | null;
  footerNote: string | null;
};

type SearchResponse = {
  query: string;
  asset: string | null;
  summary: string;
  results: ResultItem[];
  locality: string | null;
  localitySlug: string | null;
  localityUnmatched: boolean;
  localitySuggestions: LocalitySummary[];
};

export default function HomeSearch({
  localities,
}: {
  localities: LocalitySummary[];
}) {
  const [asset, setAsset] = useState("");
  const [results, setResults] = useState<ResultItem[] | null>(null);
  const { track } = useAnalytics();
  const [summary, setSummary] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [locality, setLocality] = useState<{ name: string; slug: string } | null>(null);
  const [localityUnmatched, setLocalityUnmatched] = useState(false);
  const [localitySuggestions, setLocalitySuggestions] = useState<LocalitySummary[]>([]);

  async function run(next: { q: string; asset: string }) {
    setAsset(next.asset);
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (next.q) params.set("q", next.q);
      if (next.asset) params.set("asset", next.asset);
      const res = await fetch(`/api/search?${params.toString()}`);
      if (!res.ok) throw new Error("search failed");
      const data: SearchResponse = await res.json();
      setQuery(data.query);
      setSummary(data.summary);
      setResults(data.results);
      setLocality(data.locality && data.localitySlug ? { name: data.locality, slug: data.localitySlug } : null);
      setLocalityUnmatched(data.localityUnmatched);
      setLocalitySuggestions(data.localitySuggestions);
      track("search", { query: data.query, asset: data.asset ?? next.asset });
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <SearchBox query={query} asset={asset} localities={localities} onSubmit={run} />

      {loading && (
        <p className="mt-8 text-sm text-zinc-400">Searching live listings…</p>
      )}

      {!loading && results && (
        <section className="mt-10 space-y-6">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {query && (
              <>
                <span className="text-zinc-500">Searching for:</span>
                <span className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-zinc-200">{query}</span>
              </>
            )}
            {summary && (
              <span className="rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-green-200">
                {summary}
              </span>
            )}
            {asset && (
              <span className="rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-green-200 capitalize">
                {asset}
              </span>
            )}
            {!query && asset && (
              <span className="text-zinc-500">Showing {asset} listings</span>
            )}
          </div>

          {locality && (
            <div className="rounded-2xl border border-white/10 bg-zinc-950/80 p-4 text-sm text-zinc-400">
              We found matching results in{" "}
              <Link
                href={`/localities/${locality.slug}`}
                className="font-medium text-green-300 hover:text-green-200"
              >
                {locality.name}
              </Link>
              .
            </div>
          )}

          {localityUnmatched && (
            <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200/90">
              We don&apos;t track{" "}
              <span className="font-medium text-amber-100">{query}</span> yet.
              <div className="mt-3 flex flex-wrap gap-2">
                {localitySuggestions.map((loc) => (
                  <Link
                    key={loc.slug}
                    href={`/localities/${loc.slug}`}
                    className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs text-zinc-200 hover:border-green-400/40 hover:text-white transition-colors"
                  >
                    {loc.locality}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {results.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 lg:gap-7">
              {results.map((row, i) => (
                <ListingTile
                  key={i}
                  card={row.card}
                  buildingName={row.buildingName}
                  footerNote={row.footerNote}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/10 bg-zinc-950/80 p-6 text-sm text-zinc-400">
              No live listings matched yet. We&apos;ll keep this request on file and
              follow up when matching inventory appears.
            </div>
          )}
        </section>
      )}
    </div>
  );
}
