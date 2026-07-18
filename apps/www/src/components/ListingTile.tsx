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
    <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/5 px-2.5 py-1 text-xs font-medium text-zinc-300">
      <Icon className="h-3.5 w-3.5 text-green-400" aria-hidden="true" />
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
    <div className="group relative flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/90 transition-colors hover:border-green-400/40 hover:bg-zinc-900/90">
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
              ? "border-green-400/40 bg-green-400 text-black"
              : "border-white/10 bg-black/55 text-zinc-200 hover:text-white"
          }`}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </button>
      )}

      <div className="flex flex-1 flex-col p-7 min-h-[360px] items-start text-left">
        {/* Top row: badges (no image placeholder — that space is reused below) */}
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <span className="rounded-md bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            {dealType}
          </span>
          {card.assetTypeLabel && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-green-400/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-green-300">
              <KindIcon kind={card.assetTypeLabel} className="h-3 w-3" />
              {card.assetTypeLabel}
            </span>
          )}
          <span
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${
              card.statusTone === "available"
                ? "border border-green-400/20 bg-green-400/10 text-green-300"
                : "border border-amber-400/20 bg-amber-400/10 text-amber-200"
            }`}
          >
            {card.statusLabel}
          </span>
        </div>

        <h3 className="truncate text-xl font-semibold text-white transition-colors group-hover:text-green-300">
          {card.title}
        </h3>

        {card.locality && (
          <p className="mt-2 inline-flex items-center gap-1.5 truncate text-sm text-zinc-400 text-left">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-green-400" aria-hidden="true" />
            {card.locality}
          </p>
        )}

        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-zinc-500 text-left">
          <Clock className="h-3.5 w-3.5 shrink-0 text-green-400" aria-hidden="true" />
          {card.freshnessLabel}
        </p>

        <div className="mt-4">
          <span className="text-2xl font-semibold text-white">{card.priceLabel}</span>
        </div>

        {card.specItems.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-2.5">
            {card.specItems.map((s, i) => (
              <SpecChip key={i} item={s} />
            ))}
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-3 pt-6">
          <span className="inline-flex items-center gap-1.5 truncate text-sm text-zinc-400">
            {card.brokerName && (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-green-400" aria-hidden="true" />
            )}
            {card.brokerName || "Verified network"}
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
              className="relative z-10 inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-green-400 px-4 py-2.5 text-xs font-semibold text-black transition-colors hover:bg-green-300"
            >
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              Contact
            </a>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-zinc-700 px-4 py-2.5 text-xs font-semibold text-zinc-300">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
              Contact
            </span>
          )}
        </div>

        {footerNote && <p className="mt-3 truncate text-[11px] text-zinc-500">{footerNote}</p>}
      </div>
    </div>
  );
}
