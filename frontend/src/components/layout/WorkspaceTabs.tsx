"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { MoreHorizontal, X } from "lucide-react";
import { useLayout } from "@/hooks/useLayout";
import { WorkspaceModuleMenu } from "@/components/layout/WorkspaceModuleMenu";

export function WorkspaceTabs() {
  const router = useRouter();
  const pathname = usePathname();
  const { tabs, closeTab } = useLayout();
  const [moreOpen, setMoreOpen] = useState(false);
  const currentHref = pathname;
  const visibleTabs = tabs.slice(0, 6);
  const overflowTabs = tabs.slice(6);

  function go(href: string) {
    setMoreOpen(false);
    router.push(href);
  }

  function close(id: string, href: string) {
    const index = tabs.findIndex((tab) => tab.id === id);
    closeTab(id);
    if (href === currentHref) {
      const fallback = tabs[index - 1] || tabs[index + 1] || tabs[0];
      if (fallback && fallback.id !== id) router.push(fallback.href);
    }
  }

  return (
    <div className="workspace-tab-strip shrink-0 border-b border-border" role="tablist" aria-label="Open workspace tabs">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-2 lg:px-4">
        <WorkspaceModuleMenu />
        {visibleTabs.map((tab) => {
          const active = tab.href === currentHref || (tab.href === "/inbox" && pathname === "/inbox");
          return (
            <div key={tab.id} role="tab" aria-selected={active} className={`workspace-tab ${active ? "is-active" : ""}`}>
              <button type="button" onClick={() => go(tab.href)} className="min-w-0 flex-1 truncate text-left" title={tab.title}>{tab.title}</button>
              {tab.closable && <button type="button" onClick={() => close(tab.id, tab.href)} className="workspace-tab-close" aria-label={`Close ${tab.title}`}><X className="h-3 w-3" /></button>}
            </div>
          );
        })}
        {overflowTabs.length > 0 && (
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMoreOpen((open) => !open)} className="workspace-tab-more gap-1.5" aria-expanded={moreOpen} aria-haspopup="menu" aria-label={`${overflowTabs.length} more open tabs`} title={`${overflowTabs.length} more open tabs`}><MoreHorizontal className="h-4 w-4" /><span>{overflowTabs.length} more</span></button>
            {moreOpen && <div role="menu" aria-label="More open workspace tabs" className="workspace-tab-menu absolute right-0 top-full z-[100] mt-1 w-60 rounded-xl border border-border bg-surface p-1 shadow-xl">
              <div className="px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">Open tabs</div>
              {overflowTabs.map((tab) => <div key={tab.id} role="menuitem" className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs hover:bg-surface-hover"><button type="button" onClick={() => go(tab.href)} className="min-w-0 flex-1 truncate py-1 text-left" title={tab.title}>{tab.title}</button>{tab.closable && <button type="button" onClick={() => close(tab.id, tab.href)} className="rounded p-1 text-text-muted hover:text-text-primary" aria-label={`Close ${tab.title}`}><X className="h-3 w-3" /></button>}</div>)}
            </div>}
          </div>
        )}
      </div>
    </div>
  );
}
