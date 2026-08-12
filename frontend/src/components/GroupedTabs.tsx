"use client";

import Link from "next/link";

export function GroupedTabs({ tabs, active }: { tabs: Array<{ id: string; label: string }>; active: string }) {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-white/10" aria-label="Section tabs">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={`?tab=${tab.id}`}
          aria-current={active === tab.id ? "page" : undefined}
          className={`whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${active === tab.id ? "border-emerald-400 text-white" : "border-transparent text-zinc-500 hover:text-zinc-200"}`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
