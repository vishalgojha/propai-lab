"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export type EntityMetric = {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "good" | "warn" | "accent";
};

type EntityProfileShellProps = {
  title: string;
  subtitle: string;
  backHref: string;
  backLabel: string;
  metrics?: EntityMetric[];
  actionSlot?: ReactNode;
  children: ReactNode;
};

function toneClasses(tone?: EntityMetric["tone"]) {
  switch (tone) {
    case "good":
      return "text-[#3EE88A]";
    case "warn":
      return "text-[#f59e0b]";
    case "accent":
      return "text-[#58a6ff]";
    default:
      return "text-white";
  }
}

export default function EntityProfileShell({
  title,
  subtitle,
  backHref,
  backLabel,
  metrics = [],
  actionSlot,
  children,
}: EntityProfileShellProps) {
  return (
    <div className="min-h-[calc(100vh-2rem)] rounded-[28px] border border-white/10 bg-[radial-gradient(circle_at_top_left,_rgba(88,166,255,0.12),_transparent_30%),linear-gradient(180deg,_#090d12_0%,_#070b0e_100%)] p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link href={backHref} className="text-[11px] text-zinc-500 hover:text-white transition-colors">
              {backLabel}
            </Link>
            <h1 className="mt-2 text-2xl font-bold text-white">{title}</h1>
            <div className="mt-1 text-sm text-zinc-500">{subtitle}</div>
          </div>
          {actionSlot ? <div className="flex flex-wrap gap-2">{actionSlot}</div> : null}
        </div>

        {metrics.length > 0 && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {metrics.map((metric) => (
              <MetricCard key={metric.label} metric={metric} />
            ))}
          </div>
        )}

        {children}
      </div>
    </div>
  );
}

function MetricCard({ metric }: { metric: EntityMetric }) {
  return (
    <div className="rounded-2xl border border-white/10 p-4">
      <div className={`text-2xl font-bold ${toneClasses(metric.tone)}`}>{metric.value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-zinc-500">{metric.label}</div>
      {metric.sub ? <div className="mt-1 text-[10px] text-[#475569]">{metric.sub}</div> : null}
    </div>
  );
}
