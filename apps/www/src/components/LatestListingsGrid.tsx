"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Bath, Building2, CarFront, Check, Clock3, MapPin, Ruler, Sofa, Zap } from "lucide-react";
import { buildListingSlug, cleanPublicFact, cleanStoredListingTitle, safePublicSourceNote } from "@/lib/listing-card";
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
  if (storedTitle) {
    return storedTitle.replace(/\b\d+(?:\.\d+)?\s*BHK\b\s*/gi, "Residential property ").replace(/\s{2,}/g, " ").trim();
  }
  const candidates = [row.building_name, row.landmark_name, row.location_label, row.micro_market]
    .map(text)
    .filter((value) => value && !value.includes("@") && !/^\[?unstructured\]?$/i.test(value))
    .filter((value) => !/^(listing|property listing|fresh property|unknown|immediately position)$/i.test(value));
  const place = candidates[0] || "your market";
  const intent = text(row.intent).toLowerCase();
  const transaction = intent === "rent" || intent === "rental" || intent === "lease" ? "for rent" : "for sale";
  const type = text(row.property_type).toLowerCase() === "commercial" ? "Commercial space" : "Residential property";
  return `${type} ${transaction} in ${place}`;
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

function tagLabel(tag: string): string {
  return tag.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ListingCard({ row }: { row: PublicListingSummary }) {
  const title = titleFor(row);
  const locality = text(row.micro_market) || text(row.location_label) || "Live market";
  const area = row.area_sqft && row.area_sqft > 0 ? `${Math.round(row.area_sqft).toLocaleString("en-IN")} sqft` : "";
  const furnishing = cleanPublicFact(row.furnishing)?.replace(/[_-]+/g, " ") || "";
  const intent = text(row.intent).toLowerCase();
  const typeLabel = intent === "rent" || intent === "rental" || intent === "lease" ? "For rent" : "For sale";
  const firstSeen = row.first_seen ? new Date(row.first_seen).getTime() : NaN;
  const lastSeen = row.last_seen ? new Date(row.last_seen).getTime() : NaN;
  const isJustLanded = Number.isFinite(firstSeen) && Number.isFinite(lastSeen) && lastSeen - firstSeen <= 36 * 60 * 60 * 1000;
  const tags = (row.deal_tags ?? []).filter(Boolean).slice(0, 3);
  const parking = row.car_parking_count && row.car_parking_count > 0
    ? `${row.car_parking_count} parking${row.car_parking_count > 1 ? "s" : ""}`
    : text(row.parking_type);

  return (
    <Card asChild className="listing-market-card group flex flex-col overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:border-[var(--accent-primary)] hover:shadow-[0_22px_46px_rgba(18,61,44,.14)] focus-within:ring-2 focus-within:ring-[var(--accent-primary)]">
      <Link href={hrefFor(row)}>
      <CardContent className="flex h-full flex-1 flex-col">
      <div className={`listing-market-visual relative -mx-5 -mt-5 mb-5 aspect-[16/9] overflow-hidden sm:-mx-6 sm:-mt-6 ${row.photo_url ? "has-photo" : "no-photo"}`}>
        {!row.photo_url && <><span className="listing-market-visual-mark" aria-hidden="true">{typeLabel === "For rent" ? "R" : "S"}</span><span className="listing-market-visual-caption">{text(row.property_type).toLowerCase() === "commercial" ? "Commercial space" : "Residential property"}</span></>}
        {row.photo_url && (
          <img src={row.photo_url} alt="Property photo from the broker listing" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" loading="lazy" />
        )}
        <div className="listing-market-visual-badges"><Badge variant="success" className="rounded-md bg-white/95 px-2.5 py-1 text-[10px] uppercase tracking-[0.12em]">{typeLabel}</Badge><span className="rounded-md bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-[var(--accent-forest)]">{isJustLanded ? "Just landed" : "Active listing"}</span></div>
      </div>
      <div className="flex items-start justify-between gap-3">
        <span className="listing-market-type">{text(row.property_type).toLowerCase() === "commercial" ? "Commercial" : "Residential"}</span>
        <span className="listing-market-fresh"><span aria-hidden="true" /> {isJustLanded ? "Fresh today" : updatedFor(row.last_seen).replace("Updated ", "")}</span>
      </div>

      <p className="mt-5 min-h-8 text-2xl font-semibold tracking-[-0.02em] text-[var(--price-highlight)]">{formatPublicPrice(row.price, row.price_unit, row.intent, row.price_raw_text ?? null)}</p>

      <h4 className="mt-2 min-h-[3.75rem] line-clamp-2 text-[1.3rem] font-semibold leading-[1.15] tracking-[-0.02em] text-[var(--text-primary)] group-hover:text-[var(--accent-primary)]">{title}</h4>
      <p className="mt-3 inline-flex min-h-6 items-center gap-1.5 truncate text-sm font-medium text-[var(--text-secondary)]">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
        {locality}
      </p>

      <p className="mt-2 min-h-5 line-clamp-1 text-xs leading-relaxed text-[var(--text-secondary)]">{safePublicSourceNote(row.source_notes) || "Sourced from an active broker conversation"}</p>

      <div className="mt-4 flex min-h-[4.5rem] flex-wrap content-start gap-2">
        {area && <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)]"><Ruler className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />{area}</span>}
        {furnishing && <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs font-medium capitalize text-[var(--text-secondary)]"><Sofa className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />{furnishing}</span>}
        {row.bathroom_count ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)]"><Bath className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />{row.bathroom_count} bath</span> : null}
        {parking && <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs font-medium capitalize text-[var(--text-secondary)]"><CarFront className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />{parking}</span>}
        {row.has_lift ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)]"><Building2 className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />Lift</span> : null}
        {row.has_power_backup ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-secondary)]"><Zap className="h-4 w-4 text-[var(--accent-primary)]" aria-hidden="true" />Power backup</span> : null}
        {row.photo_count ? <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-xs font-medium text-[var(--accent-forest)]"><Check className="h-4 w-4" aria-hidden="true" />Photos</span> : null}
        {tags.map((tag) => <span key={tag} className="inline-flex items-center gap-1.5 rounded-lg border border-[#d8c7a7] bg-[#fbf3e4] px-2.5 py-1.5 text-xs font-medium text-[#8b632b]"><Building2 className="h-4 w-4" aria-hidden="true" />{tagLabel(tag)}</span>)}
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4 text-xs text-[var(--text-secondary)]">
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate"><Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{row.broker_name ? `Posted by ${row.broker_name}` : updatedFor(row.last_seen)}</span>
        <span className="listing-market-action">View details <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
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
