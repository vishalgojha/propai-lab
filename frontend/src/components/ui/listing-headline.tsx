import * as React from "react";
import { cn } from "@/lib/utils";

export function ListingHeadline({ title, className, unavailableLabel = "Title unavailable", children }: { title?: string | null; className?: string; unavailableLabel?: string; children?: React.ReactNode }) {
  const present = Boolean(title && title.trim());
  return <h3 className={cn("propai-listing-headline", !present && "propai-listing-headline-empty", className)}>{present ? children || title : unavailableLabel}</h3>;
}
