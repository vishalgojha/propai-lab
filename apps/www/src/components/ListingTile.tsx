import Link from "next/link";
import { MapPin, MessageSquare, BedDouble, Ruler, Sofa, Building2, Eye, Home, Building, ShieldCheck, Clock, Flag } from "lucide-react";
import type { ListingCardViewModel, ListingSpecItem } from "@/lib/listing-card";

const SPEC_ICONS: Record<ListingSpecItem["kind"], typeof BedDouble> = {
  bhk: BedDouble,
  area: Ruler,
  furnishing: Sofa,
  floor: Building2,
  view: Eye,
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
  const initials = (card.title || buildingName || "PR")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  const isRent = /month/i.test(card.priceLabel) || card.statusLabel.toLowerCase().includes("rent");
  const dealType = isRent ? "For Rent" : "For Sale";

  return (
    <Link
      href={card.href ?? "#"}
      className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/90 transition-colors hover:border-green-400/40 hover:bg-zinc-900/90"
    >
      {/* Photo placeholder hero */}
      <div className="relative h-40 w-full bg-gradient-to-br from-green-500/20 via-zinc-900 to-zinc-950">
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-4xl font-bold tracking-wider text-white/15">{initials}</span>
        </div>
        {card.assetTypeLabel && (
          <span className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[11px] font-medium text-zinc-100 backdrop-blur">
            <KindIcon kind={card.assetTypeLabel} className="h-3 w-3" />
            {card.assetTypeLabel}
          </span>
        )}
        <span
          className={`absolute right-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-medium ${
            card.statusTone === "available"
              ? "border border-green-400/20 bg-green-400/10 text-green-300"
              : "border border-amber-400/20 bg-amber-400/10 text-amber-200"
          }`}
        >
          {card.statusLabel}
        </span>
        {card.locality && (
          <span className="absolute bottom-3 left-3 inline-flex items-center gap-1 rounded-full bg-black/55 px-2.5 py-1 text-[11px] text-zinc-200 backdrop-blur">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            {card.locality}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded-md bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            {dealType}
          </span>
          {card.assetTypeLabel && (
            <span className="rounded-md bg-green-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-300">
              {card.assetTypeLabel}
            </span>
          )}
        </div>

        <h3 className="truncate text-lg font-semibold text-white transition-colors group-hover:text-green-300">
          {card.title}
        </h3>

        <div className="mt-2">
          <span className="text-xl font-semibold text-white">{card.priceLabel}</span>
        </div>

        {card.specItems.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {card.specItems.map((s, i) => (
              <SpecChip key={i} item={s} />
            ))}
          </div>
        )}

        <div className="mt-auto flex items-center justify-between gap-3 pt-5">
          <span className="inline-flex items-center gap-1.5 truncate text-sm text-zinc-400">
            {card.brokerName && (
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-green-400" aria-hidden="true" />
            )}
            {card.brokerName || "Verified network"}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-green-400 px-3 py-2 text-xs font-semibold text-black transition-colors group-hover:bg-green-300">
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            Contact
          </span>
        </div>

        {footerNote && <p className="mt-3 truncate text-[11px] text-zinc-500">{footerNote}</p>}
      </div>
    </Link>
  );
}
