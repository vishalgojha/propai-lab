"use client";

import { type ReactNode } from "react";

interface PageProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  maxWidth?: boolean;
}

export function Page({ title, description, actions, children, maxWidth = true }: PageProps) {
  return (
    <div className={maxWidth ? "content-max px-6 lg:px-8 py-10" : "px-6 lg:px-8 py-10"}>
      <div className="flex items-start justify-between gap-6 mb-8">
        <div className="min-w-0">
          <h1 className="text-page-title text-white">{title}</h1>
          {description && (
            <p className="text-secondary mt-2 max-w-2xl">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex items-center gap-3 shrink-0">{actions}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export function Section({ title, description, children, className = "" }: { title?: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`mb-10 ${className}`}>
      {title && (
        <div className="mb-5">
          <h2 className="text-section-title text-white">{title}</h2>
          {description && <p className="text-secondary mt-1">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({ children, className = "", hover = false }: { children: ReactNode; className?: string; hover?: boolean }) {
  return (
    <div
      className={`bg-bg-surface border border-border rounded-xl p-6 ${
        hover ? "hover:border-border-strong transition-colors" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Metric({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: "green" | "red" | "blue" | "yellow" }) {
  const accentColors: Record<string, string> = {
    green: "text-green",
    red: "text-red",
    blue: "text-blue-400",
    yellow: "text-orange",
  };
  return (
    <div className="bg-bg-surface border border-border rounded-xl p-5">
      <div className={`text-[28px] font-bold leading-none tracking-tight ${accent ? accentColors[accent] : "text-white"}`}>
        {value}
      </div>
      <div className="text-secondary text-xs mt-1.5">{label}</div>
      {sub && <div className="text-caption text-xs mt-0.5">{sub}</div>}
    </div>
  );
}

export function MetricGrid({ children, cols = 5 }: { children: ReactNode; cols?: number }) {
  return (
    <div className={`grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-${cols} gap-4`}>
      {children}
    </div>
  );
}
