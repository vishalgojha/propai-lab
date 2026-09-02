import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex w-fit items-center rounded-[var(--radius-control)] border px-2 py-1 text-[10px] font-semibold leading-none", {
  variants: {
    variant: {
      default: "border-transparent bg-[var(--accent-soft)] text-[var(--signal-lime-on-mist)]",
      secondary: "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)]",
      destructive: "border-[color-mix(in_srgb,var(--alert-vermilion)_35%,transparent)] bg-[color-mix(in_srgb,var(--alert-vermilion)_12%,transparent)] text-[var(--alert-vermilion)]",
      outline: "border-[var(--border-subtle)] bg-transparent text-[var(--text-secondary)]",
      warning: "border-[color-mix(in_srgb,var(--taxi-amber-on-mist)_35%,transparent)] bg-[color-mix(in_srgb,var(--taxi-amber)_14%,transparent)] text-[var(--taxi-amber-on-mist)]",
      success: "border-[color-mix(in_srgb,var(--signal-dim)_35%,transparent)] bg-[color-mix(in_srgb,var(--signal-dim)_12%,transparent)] text-[var(--signal-dim)]",
      info: "border-[color-mix(in_srgb,var(--monsoon-teal)_35%,transparent)] bg-[color-mix(in_srgb,var(--monsoon-teal)_12%,transparent)] text-[var(--monsoon-teal)]",
      ghost: "border-transparent bg-transparent text-[var(--text-secondary)]",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}
function Badge({ className, variant, ...props }: BadgeProps) { return <span className={cn(badgeVariants({ variant }), className)} {...props} />; }

export type StatusBadgeTone = "verified" | "needs-review" | "flagged" | "fresh" | "pending" | "error";

const STATUS_META: Record<StatusBadgeTone, { label: string; variant: VariantProps<typeof badgeVariants>["variant"] }> = {
  verified: { label: "Source checked", variant: "success" },
  "needs-review": { label: "Being verified", variant: "warning" },
  flagged: { label: "Needs attention", variant: "destructive" },
  fresh: { label: "Fresh", variant: "success" },
  pending: { label: "Pending", variant: "warning" },
  error: { label: "Failed", variant: "destructive" },
};

export function StatusBadge({ tone, label, className, ...props }: { tone: StatusBadgeTone; label?: string; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const meta = STATUS_META[tone];
  return <Badge variant={meta.variant} className={cn("propai-status-badge", `propai-status-badge-${tone}`, className)} {...props}>{label || meta.label}</Badge>;
}

export { Badge, badgeVariants };
