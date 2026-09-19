import * as React from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Structural shell for every Market Inbox opportunity. Content stays owned by
 * the page/data model, while the rail, surface, selection state, and spacing
 * stay consistent across listing and requirement variants.
 */
export function MarketInboxCard({
  selected = false,
  children,
  className,
}: React.HTMLAttributes<HTMLDivElement> & { selected?: boolean }) {
  return (
    <Card
      data-propai-market-card="true"
      className={cn(
        "market-inbox-card propai-panel relative w-full rounded-[var(--radius)] px-5 py-5 sm:px-6 sm:py-6",
        selected && "!border-[var(--accent)] !bg-[var(--accent-soft)]",
        className,
      )}
    >
      <div className="propai-market-rail" aria-hidden="true" />
      {children}
    </Card>
  );
}
