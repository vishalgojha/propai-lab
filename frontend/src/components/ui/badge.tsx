import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex w-fit items-center rounded-[var(--radius-sm)] border px-2 py-1 text-[10px] font-semibold leading-none", {
  variants: {
    variant: {
      default: "border-transparent bg-[var(--muted)] text-[var(--foreground)]",
      secondary: "border-[var(--border)] bg-[var(--surface)] text-[var(--muted-foreground)]",
      destructive: "border-[var(--destructive-foreground)] bg-[var(--destructive-bg)] text-[var(--destructive-foreground)]",
      outline: "border-[var(--border)] bg-transparent text-[var(--muted-foreground)]",
      warning: "border-[var(--warning-foreground)] bg-[var(--warning-bg)] text-[var(--warning-foreground)]",
      success: "border-[var(--foreground)] bg-[var(--foreground)] text-[var(--accent-foreground)]",
      info: "border-[var(--info-foreground)] bg-[var(--info-bg)] text-[var(--info-foreground)]",
      ghost: "border-transparent bg-transparent text-[var(--muted-foreground)]",
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
