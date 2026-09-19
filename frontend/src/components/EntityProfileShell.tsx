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
      return "text-[var(--accent-text-on-light)]";
    case "warn":
      return "text-[var(--amber)]";
    case "accent":
      return "text-[var(--accent-text-on-light)]";
    default:
      return "text-[var(--foreground)]";
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
    <div className="min-h-[calc(100vh-2rem)] rounded-[28px] border border-[var(--border)] bg-[radial-gradient(circle_at_top_left,_rgba(52,_78,_65,_0.07),_transparent_30%),linear-gradient(180deg,_var(--card)_0%,_var(--muted)_100%)] p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link href={backHref} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--foreground)] transition-colors">
              {backLabel}
            </Link>
            <h1 className="mt-2 text-2xl font-bold text-[var(--foreground)]">{title}</h1>
            <div className="mt-1 text-sm text-[var(--text-muted)]">{subtitle}</div>
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
    <div className="rounded-2xl border border-[var(--border)] p-4">
      <div className={`text-2xl font-bold ${toneClasses(metric.tone)}`}>{metric.value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-[var(--text-muted)]">{metric.label}</div>
      {metric.sub ? <div className="mt-1 text-[10px] text-[var(--text-secondary)]">{metric.sub}</div> : null}
    </div>
  );
}
