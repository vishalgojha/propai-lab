"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, BedDouble, Clock3, MapPin, Ruler } from "lucide-react";
import { buildListingSlug, cleanStoredListingTitle, formatBhkNumber, safePublicSourceNote } from "@/lib/listing-card";
import { formatPublicPrice, type PublicListingSummary } from "@/lib/public-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const BATCH_SIZE = 6;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function titleFor(row: PublicListingSummary): string {
  const storedTitle = cleanStoredListingTitle(row.summary_title);
  if (storedTitle) return storedTitle;
  const candidates = [row.building_name, row.landmark_name, row.location_label, row.micro_market]
    .map(text)
    .filter((value) => value && !value.includes("@") && !/^\[?unstructured\]?$/i.test(value))
    .filter((value) => !/^(listing|property listing|fresh property|unknown|immediately position)$/i.test(value));
  const place = candidates[0] || "your market";
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
    intent: row.intent,
    title: row.summary_title,
  }) ?? String(row.id);
  return `/listings/${slug}/${row.id}`;
}

function updatedFor(value: string | null): string {
  if (!value) return "Update time unavailable";
  const date = new Date(value);
  const time = date.getTime();
  if (Number.isNaN(time)) return "Update time unavailable";
  const age = Date.now() - time;
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (age < 0 || age < hour) return "Updated just now";
  if (age < day) return `Updated ${Math.floor(age / hour)}h ago`;
  if (age < 2 * day) return "Updated yesterday";
  if (age < 7 * day) return `Updated ${Math.floor(age / day)}d ago`;
  return `Updated ${date.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
}

function ListingCard({ row }: { row: PublicListingSummary }) {
  const title = titleFor(row);
  const locality = text(row.micro_market) || text(row.location_label) || "Live market";
  const bhk = row.bhk ? formatBhkNumber(row.bhk) : "";
  const area = row.area_sqft && row.area_sqft > 0 ? `${Math.round(row.area_sqft).toLocaleString("en-IN")} sqft` : "";
  const furnishing = text(row.furnishing).replace(/[_-]+/g, " ");
  const intent = text(row.intent).toLowerCase();
  const typeLabel = intent === "rent" || intent === "rental" || intent === "lease" ? "For rent" : "For sale";

  return (
    <Card asChild className="group flex min-h-[330px] flex-col transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--accent-primary)] hover:bg-[var(--bg-surface-hover)] hover:shadow-lg focus-within:ring-2 focus-within:ring-[var(--accent-primary)]">
      <Link href={hrefFor(row)}>
      <CardContent className="flex h-full flex-1 flex-col">
      <div className="flex items-start justify-between gap-3">
        <Badge variant="success" className="rounded-md px-2.5 py-1 text-[10px] uppercase tracking-[0.12em]">
          {typeLabel}
        </Badge>
        <span className="inline-flex items-center gap-1 text-xs text-[var(--public-signal)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--public-signal)]" aria-hidden="true" />
          Fresh
        </span>
      </div>

      <h4 className="mt-5 min-h-[3.5rem] line-clamp-2 text-lg font-semibold leading-snug text-[var(--text-primary)] group-hover:text-[var(--accent-primary)]">{title}</h4>
      <p className="mt-2 inline-flex min-h-6 items-center gap-1.5 truncate text-sm text-[var(--text-secondary)]">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
        {locality}
      </p>

      <p className="mt-4 min-h-8 text-xl font-semibold text-[var(--price-highlight)]">{formatPublicPrice(row.price, row.price_unit, row.intent, row.price_raw_text ?? null)}</p>

      <p className="mt-2 min-h-12 line-clamp-2 text-xs leading-relaxed text-[var(--text-secondary)]">{safePublicSourceNote(row.source_notes) || ""}</p>

      <div className="mt-4 flex min-h-7 flex-wrap items-start gap-2 text-xs text-[var(--text-secondary)]">
        {bhk && <span className="inline-flex items-center gap-1.5"><BedDouble className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />{bhk} BHK</span>}
        {area && <span className="inline-flex items-center gap-1.5"><Ruler className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />{area}</span>}
        {furnishing && <span className="capitalize">{furnishing}</span>}
        {row.photo_count ? <Badge variant="outline" className="px-2 py-0.5 text-[var(--accent-forest)]">Has photos</Badge> : null}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4 text-xs text-[var(--text-secondary)]">
        <span className="inline-flex items-center gap-1.5 truncate"><Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{updatedFor(row.last_seen)}</span>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--accent-primary)]">View <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
      </div>
      </CardContent>
      </Link>
    </Card>
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
          <Button
            type="button"
            onClick={loadMore}
            disabled={loading}
            variant="outline"
            className="min-h-11 border-[var(--accent-primary)] bg-[var(--accent-soft)] px-5 py-2.5 text-[var(--accent-forest)] hover:bg-[var(--bg-surface-hover)] disabled:cursor-wait"
          >
            {loading ? "Loading live listings…" : "Load more listings"}
            {!loading && <ArrowRight className="h-4 w-4" aria-hidden="true" />}
          </Button>
          {error && <p role="alert" className="text-sm text-[var(--public-amber)]">{error}</p>}
        </div>
      )}
    </>
  );
}
