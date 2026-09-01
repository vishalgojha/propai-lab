import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium leading-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-[var(--accent-primary)] text-white",
        outline: "border-[var(--border-subtle)] bg-transparent text-[var(--text-secondary)]",
        success: "border-[var(--public-signal)]/35 bg-[var(--accent-soft)] text-[var(--public-signal)]",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
