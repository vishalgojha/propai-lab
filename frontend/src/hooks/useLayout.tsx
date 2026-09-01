"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";

export interface WorkspaceTab {
  id: string;
  href: string;
  title: string;
  closable: boolean;
  scrollY?: number;
}

interface LayoutContextValue {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  lastTab: string;
  setLastTab: (href: string) => void;
  tabs: WorkspaceTab[];
  closeTab: (id: string) => void;
  saveTabScroll: (href: string, scrollY: number) => void;
}

const LayoutContext = createContext<LayoutContextValue>({
  drawerOpen: false,
  setDrawerOpen: () => {},
  toggleDrawer: () => {},
  lastTab: "",
  setLastTab: () => {},
  tabs: [],
  closeTab: () => {},
  saveTabScroll: () => {},
});

const TAB_STORAGE_KEY = "propai_last_tab";
const WORKSPACE_TABS_KEY = "propai_workspace_tabs";

function titleForHref(href: string) {
  const path = href.split("?")[0];
  if (path === "/inbox") return "Market Inbox";
  const segment = path.split("/").filter(Boolean).pop() || "Workspace";
  return segment.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lastTab, setLastTabState] = useState("");
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { id: "market-inbox", href: "/inbox", title: "Market Inbox", closable: false },
  ]);

  useEffect(() => {
    setLastTabState(localStorage.getItem(TAB_STORAGE_KEY) || "/inbox");
    try {
      const saved = JSON.parse(localStorage.getItem(WORKSPACE_TABS_KEY) || "null");
      if (Array.isArray(saved) && saved.length) {
        setTabs(saved.some((tab: WorkspaceTab) => tab.id === "market-inbox") ? saved : [
          { id: "market-inbox", href: "/inbox", title: "Market Inbox", closable: false },
          ...saved,
        ]);
      }
    } catch {
      localStorage.removeItem(WORKSPACE_TABS_KEY);
    }
  }, []);

  const setLastTab = useCallback((href: string) => {
    setLastTabState(href);
    localStorage.setItem(TAB_STORAGE_KEY, href);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((current) => {
      const target = current.find((tab) => tab.id === id);
      if (!target || !target.closable) return current;
      const next = current.filter((tab) => tab.id !== id);
      localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const saveTabScroll = useCallback((href: string, scrollY: number) => {
    setTabs((current) => {
      const next = current.map((tab) => tab.href === href ? { ...tab, scrollY } : tab);
      localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen((prev) => !prev);
  }, []);

  // Close drawer on route change
  const pathname = usePathname();
  const currentHref = pathname;
  useEffect(() => {
    setDrawerOpen(false);
    setTabs((current) => {
      if (current.some((tab) => tab.href === currentHref)) return current;
      const next = [...current, { id: currentHref, href: currentHref, title: titleForHref(currentHref), closable: currentHref !== "/inbox" }];
      localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify(next));
      return next;
    });
  }, [pathname, currentHref]);

  return (
    <LayoutContext.Provider
      value={{ drawerOpen, setDrawerOpen, toggleDrawer, lastTab, setLastTab, tabs, closeTab, saveTabScroll }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  return useContext(LayoutContext);
}
