"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { usePathname } from "next/navigation";

interface LayoutContextValue {
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  toggleDrawer: () => void;
  lastTab: string;
  setLastTab: (href: string) => void;
}

const LayoutContext = createContext<LayoutContextValue>({
  drawerOpen: false,
  setDrawerOpen: () => {},
  toggleDrawer: () => {},
  lastTab: "",
  setLastTab: () => {},
});

const TAB_STORAGE_KEY = "propai_last_tab";

export function LayoutProvider({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lastTab, setLastTabState] = useState("");

  useEffect(() => {
    setLastTabState(localStorage.getItem(TAB_STORAGE_KEY) || "/inbox");
  }, []);

  const setLastTab = useCallback((href: string) => {
    setLastTabState(href);
    localStorage.setItem(TAB_STORAGE_KEY, href);
  }, []);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen((prev) => !prev);
  }, []);

  // Close drawer on route change
  const pathname = usePathname();
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <LayoutContext.Provider
      value={{ drawerOpen, setDrawerOpen, toggleDrawer, lastTab, setLastTab }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  return useContext(LayoutContext);
}
