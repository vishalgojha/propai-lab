import { cn } from "@/lib/utils";

export function PriceDisplay({ value, className, onRequestLabel = "Price on request" }: { value?: string | number | null; className?: string; onRequestLabel?: string }) {
  const present = value !== undefined && value !== null && String(value).trim() !== "";
  return <span className={cn("propai-price-display", !present && "propai-price-display-empty", className)} data-structured="true">{present ? String(value) : onRequestLabel}</span>;
}
