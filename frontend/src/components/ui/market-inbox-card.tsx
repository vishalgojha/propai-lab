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
      className={cn(
        "market-inbox-card propai-panel relative rounded-2xl px-5 py-5 sm:px-6 sm:py-6",
        selected && "border-cyan-300/50 bg-cyan-300/[0.04]",
        className,
      )}
    >
      <div className="propai-market-rail" aria-hidden="true" />
      {children}
    </Card>
  );
}
