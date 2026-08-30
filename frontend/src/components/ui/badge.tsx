import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", { variants: { variant: { default: "border-transparent bg-[var(--accent)]/15 text-[var(--accent)]", outline: "border-[var(--border)] text-[var(--text-secondary)]", warning: "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]" } }, defaultVariants: { variant: "default" } });
export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}
function Badge({ className, variant, ...props }: BadgeProps) { return <div className={cn(badgeVariants({ variant }), className)} {...props} />; }
export { Badge, badgeVariants };
