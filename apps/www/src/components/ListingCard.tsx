import Link from "next/link";
import { MapPin, Building2 } from "lucide-react";
import type { BuildingOnMap } from "@/lib/localities";
import { slugify } from "@/lib/supabase";

function formatPrice(value: number | null): string {
  if (value == null) return "Price on request";
  if (value >= 1_00_00_000) {
    const cr = value / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(1)} Cr`;
  }
  if (value >= 1_00_000) {
    const l = value / 1_00_000;
    return `₹${l % 1 === 0 ? l : l.toFixed(1)} L`;
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
      className="group block bg-zinc-900/50 border border-white/10 rounded-xl p-5 lg:p-6 transition-colors hover:border-green-400/50 hover:bg-zinc-900"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="text-lg font-semibold text-white group-hover:text-green-400 transition-colors">
          {building.name}
        </h3>
        {geocoded ? (
          <span className="flex items-center gap-1 text-xs text-green-400 font-medium whitespace-nowrap">
            <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
            On map
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-zinc-500 whitespace-nowrap">
            <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
            {building.listingCount} listings
          </span>
        )}
      </div>

      {building.address && (
        <p className="text-xs text-zinc-500 mb-3 line-clamp-1">{building.address}</p>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        {building.bhkRange && (
          <span className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs text-zinc-400">
            {building.bhkRange}
          </span>
        )}
        <span className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs text-zinc-400">
          {priceText}
        </span>
      </div>

      <p className="text-xs text-zinc-500 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" aria-hidden="true" />
        {building.listingCount} active listing{building.listingCount === 1 ? "" : "s"}
        {geocoded ? " · plotted on map" : ""}
      </p>
    </Link>
  );
}

export function LocalityBackLink() {
  return (
    <Link
      href="/localities"
      className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
    >
      <span aria-hidden="true">←</span> All localities
    </Link>
  );
}
