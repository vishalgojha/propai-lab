import { BedDouble, Ruler, Sofa, Building2, Eye, Tag } from "lucide-react";
import type { ListingSpecItem } from "@/lib/listing-card";

const ICONS: Record<ListingSpecItem["kind"], typeof BedDouble> = {
  bhk: BedDouble,
  area: Ruler,
  furnishing: Sofa,
  floor: Building2,
  view: Eye,
  type: Tag,
};

export default function ListingSpecs({
  items,
  className = "",
}: {
  items: ListingSpecItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-zinc-400 ${className}`}>
      {items.map((item, i) => {
        const Icon = ICONS[item.kind];
        return (
          <span key={`${item.kind}-${i}`} className="inline-flex items-center gap-1.5">
            <Icon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
            {item.label}
          </span>
        );
      })}
    </div>
  );
}
