"use client";

interface BadgeProps {
  variant?: "green" | "red" | "yellow" | "blue" | "gray" | "purple" | "orange";
  children: string;
}

const variantMap: Record<string, string> = {
  green: "badge-green",
  red: "badge-red",
  yellow: "badge-yellow",
  blue: "badge-blue",
  gray: "badge-gray",
  purple: "badge-purple",
  orange: "badge-orange",
};

export function Badge({ variant = "gray", children }: BadgeProps) {
  return (
    <span className={`badge ${variantMap[variant] || "badge-gray"}`}>
      {children}
    </span>
  );
}
