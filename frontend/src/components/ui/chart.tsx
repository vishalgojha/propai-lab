"use client";

import * as React from "react";
import { ResponsiveContainer, Tooltip, type TooltipProps } from "recharts";
import { cn } from "@/lib/utils";

export type ChartConfig = Record<string, { label?: string; color?: string }>;

export function ChartContainer({ config, className, children }: { config?: ChartConfig; className?: string; children: React.ReactElement }) {
  const variables = Object.entries(config || {}).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value.color) acc[`--color-${key}`] = value.color;
    return acc;
  }, {});
  return <div className={cn("min-h-[220px] w-full", className)} style={variables as React.CSSProperties}><ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer></div>;
}

export function ChartTooltip({ content, ...props }: TooltipProps<number, string> & { content?: React.ReactNode }) {
  return <Tooltip {...props} content={content || <ChartTooltipContent />} />;
}

export function ChartTooltipContent({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  return <div className="rounded-lg border border-white/15 bg-zinc-950/95 px-3 py-2 text-xs shadow-xl"><div className="mb-1 text-zinc-400">{label}</div>{payload.map((entry) => <div key={String(entry.dataKey)} className="flex items-center justify-between gap-5 font-medium text-white"><span>{entry.name || entry.dataKey}</span><span>{typeof entry.value === "number" ? entry.value.toLocaleString("en-IN") : entry.value}</span></div>)}</div>;
}
