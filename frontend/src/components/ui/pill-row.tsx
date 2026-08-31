import { cn } from "@/lib/utils";

export type PillTone = "neutral" | "teal" | "lime" | "amber" | "vermilion";
export interface PillItem { label: string; tone?: PillTone; }

export function PillRow({ items, className }: { items: PillItem[]; className?: string }) {
  return <div className={cn("propai-pill-row", className)}>{items.filter((item) => item.label.trim()).map((item) => <span key={`${item.tone || "neutral"}-${item.label}`} className={`propai-pill propai-pill-${item.tone || "neutral"}`}>{item.label}</span>)}</div>;
}
