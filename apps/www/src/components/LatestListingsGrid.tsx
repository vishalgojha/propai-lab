"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, BedDouble, Clock3, MapPin, Ruler } from "lucide-react";
import { buildListingSlug, formatBhkNumber } from "@/lib/listing-card";
import { formatPublicPrice, type PublicListingSummary } from "@/lib/public-data";

const BATCH_SIZE = 6;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function titleFor(row: PublicListingSummary): string {
  const candidates = [row.building_name, row.landmark_name, row.summary_title, row.location_label, row.micro_market]
    .map(text)
    .filter((value) => value && !value.includes("@") && !/^\[?unstructured\]?$/i.test(value))
    .filter((value) => !/^(listing|property listing|fresh property|unknown|immediately position)$/i.test(value));
  const place = candidates[0] || "Mumbai";
  const bhk = row.bhk ? formatBhkNumber(row.bhk) : "";
  const intent = text(row.intent).toLowerCase();
  const transaction = intent === "rent" || intent === "rental" || intent === "lease" ? "for rent" : "for sale";
  return `${bhk ? `${bhk} BHK ` : "Property "}${transaction} in ${place}`;
}

function hrefFor(row: PublicListingSummary): string {
  const slug = buildListingSlug({
    id: row.id,
    bhk: row.bhk,
    micro_market: row.micro_market,
    building_name: row.building_name,
    property_type: row.property_type,
  }) ?? String(row.id);
  return `/listings/${slug}/${row.id}`;
}

function updatedFor(value: string | null): string {
  if (!value) return "Recently updated";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Recently updated"
    : `Updated ${date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
}

function ListingCard({ row }: { row: PublicListingSummary }) {
  const title = titleFor(row);
  const locality = text(row.micro_market) || text(row.location_label) || "Mumbai";
  const bhk = row.bhk ? formatBhkNumber(row.bhk) : "";
  const area = row.area_sqft && row.area_sqft > 0 ? `${Math.round(row.area_sqft).toLocaleString("en-IN")} sqft` : "";
  const furnishing = text(row.furnishing).replace(/[_-]+/g, " ");
  const intent = text(row.intent).toLowerCase();
  const typeLabel = intent === "rent" || intent === "rental" || intent === "lease" ? "For rent" : "For sale";

  return (
    <Link
      href={hrefFor(row)}
      className="group flex min-h-[270px] flex-col rounded-2xl border border-white/10 bg-[#173325] p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-[#4fb27d]/70 hover:bg-[#1b3d2c] hover:shadow-lg hover:shadow-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4fb27d]"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-md border border-[#4fb27d]/40 bg-[#214936] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9ed7b7]">
          {typeLabel}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-[#9ed7b7]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#4fb27d]" aria-hidden="true" />
          Fresh
        </span>
      </div>

      <h4 className="mt-5 line-clamp-2 text-lg font-semibold leading-snug text-[#f4ead8] group-hover:text-white">{title}</h4>
      <p className="mt-2 inline-flex items-center gap-1.5 truncate text-sm text-[#a6c3b2]">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-[#78c99b]" aria-hidden="true" />
        {locality}
      </p>

      <p className="mt-4 text-xl font-semibold text-[#f0a52f]">{formatPublicPrice(row.price, row.price_unit, row.intent)}</p>

      <div className="mt-4 flex min-h-7 flex-wrap gap-2 text-xs text-[#b8d0c1]">
        {bhk && <span className="inline-flex items-center gap-1.5"><BedDouble className="h-3.5 w-3.5 text-[#78c99b]" aria-hidden="true" />{bhk} BHK</span>}
        {area && <span className="inline-flex items-center gap-1.5"><Ruler className="h-3.5 w-3.5 text-[#78c99b]" aria-hidden="true" />{area}</span>}
        {furnishing && <span className="capitalize">{furnishing}</span>}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/10 pt-4 text-xs text-[#8eae9d]">
        <span className="inline-flex items-center gap-1.5 truncate"><Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{updatedFor(row.last_seen)}</span>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-[#78c99b] group-hover:text-[#b0e6c6]">View <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
      </div>
    </Link>
  );
}

export default function LatestListingsGrid({ initialListings }: { initialListings: PublicListingSummary[] }) {
  const [listings, setListings] = useState(initialListings.slice(0, BATCH_SIZE));
  const [offset, setOffset] = useState(BATCH_SIZE);
  const [hasMore, setHasMore] = useState(initialListings.length > BATCH_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/latest-listings?offset=${offset}&limit=${BATCH_SIZE}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load more listings");
      const payload = await response.json() as { listings?: PublicListingSummary[]; hasMore?: boolean };
      const next = Array.isArray(payload.listings) ? payload.listings : [];
      setListings((current) => [...current, ...next]);
      setOffset((current) => current + next.length);
      setHasMore(Boolean(payload.hasMore));
    } catch {
      setError("More live listings could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {listings.map((row) => <ListingCard key={`${row.card_type ?? "listing"}-${row.id}`} row={row} />)}
      </div>
      {(hasMore || error) && (
        <div className="mt-7 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#4fb27d]/70 bg-[#214936] px-5 py-2.5 text-sm font-semibold text-[#d5f0df] transition-colors hover:bg-[#2a5a40] disabled:cursor-wait disabled:opacity-60"
          >
            {loading ? "Loading live listings…" : "Load more listings"}
            {!loading && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
          </button>
          {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
        </div>
      )}
    </>
  );
}
