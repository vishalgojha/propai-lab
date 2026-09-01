import Link from "next/link";
import { MapPin, Building2, ArrowRight } from "lucide-react";
import type { BuildingOnMap } from "@/lib/localities";
import { slugify } from "@/lib/supabase";
import { Badge } from "@/components/ui/badge";

function formatPrice(value: number | null): string {
  if (value == null) return "Price on request";
  if (value >= 1_00_00_000) {
    const cr = value / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(1)} Cr`;
  }
  if (value >= 1_00_000) {
    const l = value / 1_00_000;
    return `₹${l % 1 === 0 ? l : l.toFixed(1)} Lakh`;
  }
  return `₹${value.toLocaleString("en-IN")}`;
}

export default function ListingCard({ building }: { building: BuildingOnMap }) {
  const hasPrice = building.minPrice != null && building.maxPrice != null;
  const priceText = hasPrice
    ? building.minPrice === building.maxPrice
      ? formatPrice(building.minPrice)
      : `${formatPrice(building.minPrice)} – ${formatPrice(building.maxPrice)}`
    : "Price on request";

  const geocoded = building.latitude != null && building.longitude != null;
  const href = `/buildings/${slugify(building.name)}`;

return (
        <Link
          href={href}
          className="group block rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 transition-all duration-base hover:border-[var(--accent-primary)] hover:bg-[var(--bg-surface-hover)] hover:scale-[1.02] hover:shadow-lg hover:shadow-[var(--accent-primary)]/10 active:scale-[0.98] lg:p-6"
        >
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="text-lg font-semibold text-[var(--text-primary)] transition-colors group-hover:text-[var(--accent-primary)]">
          {building.name}
        </h3>
        {geocoded ? (
          <span className="flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[var(--public-signal)]">
            <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
            On map
          </span>
        ) : (
          <span className="flex items-center gap-1 whitespace-nowrap text-xs text-[var(--text-secondary)]">
            <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
            {building.listingCount} listings
          </span>
        )}
      </div>

      {building.address && (
        <p className="mb-3 line-clamp-1 text-xs text-[var(--text-secondary)]">{building.address}</p>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        {building.bhkRange && (
          <Badge>
            {building.bhkRange}
          </Badge>
        )}
        <Badge>
          {priceText}
        </Badge>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-3 text-xs">
        <p className="flex items-center gap-1 text-[var(--text-secondary)]">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--public-signal)]" aria-hidden="true" />
        {building.listingCount} active listing{building.listingCount === 1 ? "" : "s"}
        {geocoded ? " · plotted on map" : ""}
        </p>
        <span className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--accent-primary)] transition-transform group-hover:translate-x-0.5">
          View listings <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

export function LocalityBackLink() {
  return (
    <Link
      href="/localities"
      className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
    >
      <span aria-hidden="true">←</span> All localities
    </Link>
  );
}
