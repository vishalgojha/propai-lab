"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MapPin, ArrowRight, Search } from "lucide-react";
import { slugify } from "@/lib/supabase";
import type { LocalitySummary } from "@/lib/localities";

type Props = {
  knownLocalities: LocalitySummary[];
};

export default function LocalitySearch({ knownLocalities }: Props) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<LocalitySummary[]>([]);
  const [showNoMatch, setShowNoMatch] = useState(false);

  function hasPropertySignals(next: string) {
    return /\b\d+(?:\.\d+)?\s*bhk\b|\b(budget|under|below|max|upto|up to|rent|rental|sale|sell|buy|furnished|furnishing|office|shop|showroom|commercial)\b|₹|\b(?:cr|crore|crores|l|lac|lakh|lakhs|k)\b/i.test(next);
  }

  function updateSuggestions(next: string) {
    const q = slugify(next);
    const natural = hasPropertySignals(next);
    if (!q) {
      setSuggestions([]);
      setShowNoMatch(false);
      return;
    }
    const scored = knownLocalities
      .map((loc) => {
        const locSlug = loc.slug;
        let score = 0;
        if (locSlug === q) score = 100;
        else if (locSlug.startsWith(q)) score = 70;
        else if (locSlug.includes(q)) score = 40;
        else if (q.includes(locSlug) && locSlug.length >= 3) score = 20;
        return { loc, score };
      })
      .filter((s) => s.score > 0)
      .sort(
        (a, b) => b.score - a.score || b.loc.listingCount - a.loc.listingCount,
      )
      .slice(0, 6)
      .map((s) => s.loc);

    setSuggestions(scored);
    setShowNoMatch(scored.length === 0 && !natural);
  }

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) return;
    const natural = hasPropertySignals(trimmed);
    const slug = slugify(trimmed);
    const exact = knownLocalities.find((l) => l.slug === slug);
    if (exact && !natural) {
      router.push(`/localities/${exact.slug}`);
      return;
    }
    if (!natural && suggestions.length > 0) {
      router.push(`/localities/${suggestions[0].slug}`);
      return;
    }
    if (natural || suggestions.length === 0) {
      router.push(`/search?q=${encodeURIComponent(trimmed)}`);
      return;
    }
    // No known localities available at all (e.g. data source slow/unavailable)
    // — still give a forward path instead of a blank dead-end.
    if (knownLocalities.length === 0) {
      router.push("/localities");
      return;
    }
    setShowNoMatch(true);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="max-w-3xl mx-auto rounded-[28px] border border-white/10 bg-zinc-950/90 p-5 lg:p-8 shadow-[0_25px_80px_rgba(0,0,0,0.45)]">
      <label
        htmlFor="locality-search"
        className="block text-sm font-medium text-zinc-400 mb-3"
      >
        Search localities or describe what you need
      </label>
      <div className="relative">
        <MapPin
          className="absolute left-5 top-1/2 -translate-y-1/2 text-zinc-500 w-5 h-5"
          aria-hidden="true"
        />
        <input
          type="search"
          id="locality-search"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            updateSuggestions(e.target.value);
            if (showNoMatch && e.target.value.trim()) setShowNoMatch(false);
          }}
          onKeyDown={onKeyDown}
          placeholder="e.g. 3 BHK in Bandra West budget 2 to 3 lakh"
          className="w-full bg-black/80 border border-white/10 rounded-2xl pl-14 pr-24 py-5 lg:py-6 text-white placeholder:text-zinc-500 focus:border-green-400 focus:outline-none focus:ring-1 focus:ring-green-400 text-[16px] lg:text-lg"
          autoComplete="off"
          aria-describedby={showNoMatch ? "locality-nomatch" : undefined}
        />
        <button
          type="button"
          onClick={submit}
          aria-label="Search listings"
          className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center h-11 px-4 rounded-xl bg-green-400 text-black hover:bg-green-300 transition-colors font-semibold text-sm"
        >
          Search
          <ArrowRight className="w-4 h-4 ml-2" aria-hidden="true" />
        </button>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Try a locality name, building, broker, or a full request like “3 BHK in Bandra West budget 2 to 3 lakh”.
      </p>

      {suggestions.length > 0 && value.trim() && (
        <ul className="mt-3 rounded-xl border border-white/10 bg-zinc-950 divide-y divide-white/5 overflow-hidden">
          {suggestions.map((loc) => (
            <li key={loc.slug}>
              <button
                type="button"
                onClick={() => router.push(`/localities/${loc.slug}`)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-900 transition-colors"
              >
                <span className="flex items-center gap-2 text-white">
                  <Search className="w-4 h-4 text-zinc-500" aria-hidden="true" />
                  {loc.locality}
                </span>
                <span className="text-xs text-zinc-500 whitespace-nowrap">
                  {loc.listingCount} listings
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {showNoMatch && (
        <div id="locality-nomatch" className="mt-3 text-sm text-zinc-400">
          {knownLocalities.length > 0 ? (
            <>
              <p>
                No exact match for{" "}
                <span className="text-white">&quot;{value.trim()}&quot;</span>.
              </p>
              <p className="mt-2">
                {suggestions.length > 0 ? (
                  <>
                    Try{" "}
                    <button
                      type="button"
                      onClick={() => router.push(`/localities/${suggestions[0].slug}`)}
                      className="text-green-400 font-medium hover:underline"
                    >
                      {suggestions[0].locality}
                    </button>{" "}
                    — it has {suggestions[0].listingCount} live listing
                    {suggestions[0].listingCount === 1 ? "" : "s"}.
                  </>
                ) : (
                  <>Browse a locality with live listings instead:</>
                )}
              </p>
              {suggestions.length === 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {knownLocalities.slice(0, 5).map((loc) => (
                    <li key={loc.slug}>
                      <button
                        type="button"
                        onClick={() => router.push(`/localities/${loc.slug}`)}
                        className="text-green-400 hover:underline"
                      >
                        {loc.locality}
                      </button>{" "}
                      <span className="text-zinc-500">
                        ({loc.listingCount} listings)
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p>
              We couldn&apos;t load the locality list right now.{" "}
              <Link href="/localities" className="text-green-400 hover:underline">
                Browse all localities
              </Link>{" "}
              instead.
            </p>
          )}
        </div>
      )}

      <p className="text-xs text-zinc-500 mt-3 text-center">
        Powered by live WhatsApp broker conversations
      </p>
    </div>
  );
}
