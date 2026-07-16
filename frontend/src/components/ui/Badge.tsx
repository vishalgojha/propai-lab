"use client";

interface BadgeProps {
  variant?: "neutral" | "success" | "error";
  children: string;
}

const variantMap: Record<NonNullable<BadgeProps["variant"]>, string> = {
  neutral: "badge-neutral",
  success: "badge-success",
  error: "badge-error",
};

export function Badge({ variant = "neutral", children }: BadgeProps) {
  return (
    <span className={`badge ${variantMap[variant]}`}>
      {children}
    </span>
  );
}
