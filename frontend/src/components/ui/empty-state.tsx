import { MapPinOff, CircleDollarSign, Building2, FileQuestion } from "lucide-react";
import { cn } from "@/lib/utils";

export type MissingField = "address" | "locality" | "price" | "title";
const EMPTY_META: Record<MissingField, { label: string; detail: string; Icon: typeof MapPinOff }> = {
  address: { label: "Address unavailable", detail: "The source message did not include a verified address.", Icon: MapPinOff },
  locality: { label: "Locality unavailable", detail: "No locality was grounded in the captured source yet.", Icon: Building2 },
  price: { label: "Price on request", detail: "The source did not include a usable price.", Icon: CircleDollarSign },
  title: { label: "Title unavailable", detail: "The source does not contain enough detail for a listing headline.", Icon: FileQuestion },
};

export function EmptyState({ field, compact = false, className }: { field: MissingField; compact?: boolean; className?: string }) {
  const meta = EMPTY_META[field];
  const Icon = meta.Icon;
  return <div className={cn("propai-empty-state", compact && "propai-empty-state-compact", `propai-empty-state-${field}`, className)}><Icon aria-hidden="true" /><span><strong>{meta.label}</strong>{!compact && <small>{meta.detail}</small>}</span></div>;
}
