"use client";

import Link from "next/link";

export function GroupedTabs({ tabs, active }: { tabs: Array<{ id: string; label: string }>; active: string }) {
  return (
    <nav className="propai-grouped-tabs mb-4 flex gap-1 overflow-x-auto border-b border-[var(--zone-light-border)]" aria-label="Section tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={`?tab=${tab.id}`}
          aria-current={active === tab.id ? "page" : undefined}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${active === tab.id ? "border-[var(--accent-primary)] text-[var(--zone-light-text-primary)]" : "border-transparent text-[var(--zone-light-text-secondary)] hover:text-[var(--zone-light-text-primary)]"}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
