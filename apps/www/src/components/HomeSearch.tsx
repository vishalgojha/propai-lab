"use client";

import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [asset, setAsset] = useState("");
  const { track } = useAnalytics();

  function run(next: { q: string; asset: string }) {
    setAsset(next.asset);
    track("search", { query: next.q, asset: next.asset ?? next.asset });
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.asset) params.set("asset", next.asset);
    router.push(`/search?${params.toString()}`);
  }

  return (
    <div>
      <SearchBox query={""} asset={asset} localities={localities} onSubmit={run} />
    </div>
  );
}
