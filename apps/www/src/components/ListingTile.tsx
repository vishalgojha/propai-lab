"use client";

import { useEffect } from "react";
import Link from "next/link";
import { MapPin, MessageSquare, BedDouble, Ruler, Sofa, Building2, Eye, Home, Building, ShieldCheck, Tag, Check, Clock } from "lucide-react";
import type { ListingCardViewModel, ListingSpecItem } from "@/lib/listing-card";
import { useShortlist } from "@/components/ShortlistProvider";
import { useAnalytics } from "@/lib/useAnalytics";

const SPEC_ICONS: Record<ListingSpecItem["kind"], typeof BedDouble> = {
  bhk: BedDouble,
  area: Ruler,
  furnishing: Sofa,
  floor: Building2,
  view: Eye,
  type: Tag,
};

const KindIcon = ({ kind, className }: { kind: string | null; className?: string }) =>
  kind === "Commercial" ? (
    <Building className={className} strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <Home className={className} strokeWidth={1.75} aria-hidden="true" />
  );

function SpecChip({ item }: { item: ListingSpecItem }) {
  const Icon = SPEC_ICONS[item.kind] ?? BedDouble;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]">
      <Icon className="h-3.5 w-3.5 text-[var(--accent-forest)]" aria-hidden="true" />
      {item.label}
    </span>
  );
}

export default function ListingTile({
  card,
  buildingName,
  footerNote,
}: {
  card: ListingCardViewModel;
  buildingName?: string | null;
  footerNote?: string | null;
}) {
  const isRent = /month/i.test(card.priceLabel) || card.statusLabel.toLowerCase().includes("rent");
  const dealType = isRent ? "For Rent" : "For Sale";
  const { has, toggle } = useShortlist();
  const { track } = useAnalytics();
  const listingId = card.href ? Number(card.href.split("/").pop()) : null;
  const shortlisted = listingId != null && has(listingId);

  useEffect(() => {
    if (listingId != null) track("listing_view", { listingId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId]);

  function toggleShortlist(e: React.MouseEvent) {
    e.stopPropagation();
    if (listingId == null) return;
    const wasAdded = !shortlisted;
    toggle({
      id: listingId,
      title: card.title,
      locality: card.locality,
      priceLabel: card.priceLabel,
      href: card.href,
    });
    track(wasAdded ? "shortlist_add" : "shortlist_remove", { listingId });
  }

  return (
    <div className="group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] transition-colors duration-base hover:border-[var(--accent-primary)] hover:bg-[var(--bg-surface-hover)]">
      {/* Stretched link makes the whole card clickable to the listing, while
          the Contact button (z-10) stays an independent, working link. */}
      {card.href && (
        <Link
          href={card.href}
          className="absolute inset-0 z-0"
          aria-label={card.title}
        />
      )}

      {listingId != null && (
        <button
          type="button"
          onClick={toggleShortlist}
          aria-pressed={shortlisted}
          aria-label={shortlisted ? "Remove from shortlist" : "Add to shortlist"}
          className={`absolute right-3 top-3 z-10 inline-flex h-9 w-9 items-center justify-center rounded-full border backdrop-blur transition-colors ${
            shortlisted
              ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[#FAF7F0]"
              : "border-[var(--border-subtle)] bg-[var(--bg-base)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </button>
      )}

      <div className="flex min-h-[300px] flex-1 flex-col items-start p-5 text-left sm:min-h-[320px] sm:p-6">
        {/* Top row: badges (no image placeholder — that space is reused below) */}
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <span className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
            {dealType}
          </span>
          {card.assetTypeLabel && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent-soft)] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent-forest)]">
              <KindIcon kind={card.assetTypeLabel} className="h-3 w-3" />
              {card.assetTypeLabel}
            </span>
          )}
          <span
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              card.statusTone === "listed"
                ? "border border-[var(--accent-primary)] bg-[var(--accent-soft)] text-[var(--accent-forest)]"
                : "border border-amber-700/30 bg-amber-100/60 text-amber-800"
            }`}
          >
            {card.statusLabel}
          </span>
          {card.freshnessBadge && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent-forest)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--accent-primary)]" aria-hidden="true" />
              {card.freshnessBadge}
            </span>
          )}
        </div>

        <h3 className="line-clamp-2 text-lg font-semibold text-[var(--text-primary)] transition-colors group-hover:text-[var(--accent-forest)] sm:text-xl">
          {card.title}
        </h3>

        {card.locality && (
          <p className="mt-2 inline-flex items-center gap-1.5 line-clamp-1 text-sm text-[var(--text-secondary)] text-left">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-[var(--accent-forest)]" aria-hidden="true" />
            {card.locality}
          </p>
        )}

        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)] text-left">
          <Clock className="h-3.5 w-3.5 shrink-0 text-[var(--accent-forest)]" aria-hidden="true" />
          {card.freshnessLabel}
        </p>

        <div className="mt-4">
          <span className="text-2xl font-semibold text-[var(--price-highlight)]">{card.priceLabel}</span>
        </div>

        {card.specItems.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2.5">
            {card.specItems.map((s, i) => (
              <SpecChip key={i} item={s} />
            ))}
          </div>
        )}

        <div className="mt-auto flex w-full items-center justify-between gap-3 pt-5">
          <span className="inline-flex min-w-0 items-center gap-1.5 line-clamp-1 text-sm text-[var(--text-secondary)]">
            {card.brokerName && (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--accent-forest)]" aria-hidden="true" />
            )}
            {card.brokerName || "PropAI network"}
          </span>
          {card.waLink ? (
            <a
              href={card.waLink}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                e.stopPropagation();
                track("contact_click", { listingId });
              }}
              className="relative z-10 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent-primary)] px-4 py-2.5 text-xs font-semibold text-[#FAF7F0] transition-colors hover:bg-[var(--accent-primary-hover)]"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              WhatsApp
            </a>
          ) : (
            <span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-base)] px-4 py-2.5 text-xs font-semibold text-[var(--text-secondary)]">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              WhatsApp unavailable
            </span>
          )}
        </div>

        {footerNote && <p className="mt-3 truncate text-[11px] text-[var(--text-secondary)]">{footerNote}</p>}
      </div>
    </div>
  );
}
