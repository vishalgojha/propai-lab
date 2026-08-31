import { cn } from "@/lib/utils";

export function ListingHeadline({ title, className, unavailableLabel = "Title unavailable" }: { title?: string | null; className?: string; unavailableLabel?: string }) {
  const present = Boolean(title && title.trim());
  return <h3 className={cn("propai-listing-headline", !present && "propai-listing-headline-empty", className)}>{present ? title : unavailableLabel}</h3>;
}
