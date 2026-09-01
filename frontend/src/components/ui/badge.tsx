import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Check, CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-md border px-2 py-1 text-[10px] font-semibold leading-none", {
  variants: {
    variant: {
      default: "border-transparent bg-[var(--accent-soft)] text-[var(--signal-lime-on-mist)]",
      outline: "border-[var(--border-subtle)] bg-transparent text-[var(--text-secondary)]",
      warning: "border-[color-mix(in_srgb,var(--taxi-amber-on-mist)_35%,transparent)] bg-[color-mix(in_srgb,var(--taxi-amber)_14%,transparent)] text-[var(--taxi-amber-on-mist)]",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}
function Badge({ className, variant, ...props }: BadgeProps) { return <div className={cn(badgeVariants({ variant }), className)} {...props} />; }

export type StatusBadgeTone = "verified" | "needs-review" | "flagged";

const STATUS_META: Record<StatusBadgeTone, { label: string; Icon: typeof Check }> = {
  verified: { label: "Source checked", Icon: Check },
  "needs-review": { label: "Being verified", Icon: TriangleAlert },
  flagged: { label: "Needs attention", Icon: CircleAlert },
};

export function StatusBadge({ tone, label, className, ...props }: { tone: StatusBadgeTone; label?: string; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const meta = STATUS_META[tone];
  const Icon = meta.Icon;
  return <span className={cn("propai-status-badge", `propai-status-badge-${tone}`, className)} {...props}><Icon aria-hidden="true" />{label || meta.label}</span>;
}

export { Badge, badgeVariants };
