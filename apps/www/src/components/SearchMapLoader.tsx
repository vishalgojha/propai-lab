"use client";

import dynamic from "next/dynamic";
import "mapbox-gl/dist/mapbox-gl.css";
import type { NaturalSearchResult } from "@/lib/natural-search";

const SearchMap = dynamic(() => import("./SearchMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[360px] lg:h-[480px] rounded-2xl border border-white/10 bg-zinc-900/50 animate-pulse" />
  ),
});

export default function SearchMapLoader({
  results,
  token,
}: {
  results: NaturalSearchResult[];
  token: string | null;
}) {
  return <SearchMap results={results} token={token} />;
}
