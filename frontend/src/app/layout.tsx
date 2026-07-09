"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import "./globals.css";
import { getConnectionState, getWhatsAppStatus, ConnectionState, WhatsAppStatus, searchMessages } from "@/lib/api";
import {
  MessageSquare,
  BarChart3,
  Search,
  Building2,
  Briefcase,
  Brain,
  ClipboardCheck,
  Wifi,
  WifiOff,
  UserCheck,
  UserCog,
  Users,
  BookOpen,
  MapPin,
  GraduationCap,
  Radar,
  TrendingUp,
  Key,
  Menu,
  X,
} from "lucide-react";
import { LayoutProvider, useLayout } from "@/hooks/useLayout";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { BottomNav } from "@/components/layout/BottomNav";
import { MobileDrawer } from "@/components/layout/MobileDrawer";
import { InstallPrompt } from "@/components/layout/InstallPrompt";
import { ServiceWorkerRegister } from "@/components/layout/ServiceWorkerRegister";

const navSections = [
  {
    title: "Conversations",
    items: [
      { href: "/inbox", label: "Market Inbox", icon: MessageSquare },
    ],
  },
  {
    title: "Market",
    items: [
      { href: "/requirements", label: "Requirements", icon: ClipboardCheck },
      { href: "/my/inventory", label: "Inventory", icon: Building2 },
      { href: "/brokers", label: "Brokers", icon: Briefcase },
      { href: "/buildings", label: "Buildings", icon: Building2 },
      { href: "/groups", label: "Groups", icon: Users },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/clients", label: "Clients", icon: UserCheck },
      { href: "/deals", label: "Deals", icon: TrendingUp },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
      { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
      { href: "/chat", label: "AI Chat", icon: Brain },
      { href: "/market", label: "Markets", icon: MapPin },
      { href: "/audit", label: "Audit", icon: Radar },
    ],
  },
  {
    title: "Settings",
    items: [
      { href: "/connections", label: "Connection", icon: Wifi },
      { href: "/workspace/members", label: "Team", icon: UserCog },
      { href: "/waba", label: "API", icon: Key },
      { href: "/trainer", label: "Trainer", icon: GraduationCap },
    ],
  },
];

function PaletteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, any[]> | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const flatItems = results ? Object.values(results).flat() : [];

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults(null);
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!query.trim()) { setResults(null); return; }
    const t = setTimeout(async () => {
      try {
        const data = await searchMessages(query);
        setResults(data);
        setSelectedIdx(0);
      } catch { setResults({}); }
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  function navigate(path: string) {
    onClose();
    router.push(path);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const total = flatItems.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, total - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      const r = flatItems[selectedIdx];
      if (!r) return;
      if (r.name && r.occurrence_count !== undefined) navigate(`/search?q=${encodeURIComponent(r.name)}`);
      else if (r.name && r.observation_count !== undefined) navigate(`/brokers?q=${encodeURIComponent(r.name)}`);
      else if (r.micro_market && !r.broker_name) navigate(`/market?q=${encodeURIComponent(r.micro_market)}`);
      else if (r.building_name) navigate(`/search?q=${encodeURIComponent(r.building_name)}`);
      else if (r.broker_name) navigate(`/brokers?q=${encodeURIComponent(r.broker_name)}`);
    }
    else if (e.key === "Escape") onClose();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center pt-[15vh] bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg mx-4 bg-zinc-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/5">
          <Search className="w-4 h-4 text-zinc-500 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search properties, brokers, buildings..."
            className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none min-w-0"
          />
          <kbd className="text-[10px] text-zinc-500 bg-white/5 px-1.5 py-0.5 rounded shrink-0">ESC</kbd>
        </div>
        {results && (
          <div className="max-h-80 overflow-y-auto py-2">
            {Object.entries(results).map(([group, items]) => (
              <div key={group}>
                <div className="px-4 py-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">{group}</div>
                {items.map((item: any, i: number) => {
                  const globalIdx = flatItems.indexOf(item);
                  const isSelected = globalIdx === selectedIdx;
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        if (item.name && item.occurrence_count !== undefined) navigate(`/search?q=${encodeURIComponent(item.name)}`);
                        else if (item.micro_market) navigate(`/market?q=${encodeURIComponent(item.micro_market)}`);
                        else if (item.building_name) navigate(`/search?q=${encodeURIComponent(item.building_name)}`);
                        else if (item.broker_name) navigate(`/brokers?q=${encodeURIComponent(item.broker_name)}`);
                      }}
                      className={`w-full text-left px-4 py-2 text-sm flex items-center gap-3 ${isSelected ? "bg-blue-500/10 text-white" : "text-zinc-400 hover:bg-white/5"}`}
                    >
                      <span className="text-xs text-zinc-500 w-4 text-right shrink-0">{globalIdx + 1}</span>
                      <span className="truncate">{item.name || item.micro_market || item.building_name || item.broker_name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {flatItems.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-zinc-500">No results found</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isMobile = useIsMobile();
  const { drawerOpen, setDrawerOpen, toggleDrawer, setLastTab } = useLayout();
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [offline, setOffline] = useState(false);

  const waConnected = conn?.connected;

  useEffect(() => {
    const load = async () => {
      try {
        const [c, w] = await Promise.all([getConnectionState(), getWhatsAppStatus()]);
        setConn(c);
        setWhatsapp(w);
      } catch {}
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  // Offline detection
  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(p => !p);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    document.body.classList.toggle("no-scroll", drawerOpen);
  }, [drawerOpen]);

  return (
    <div className="flex h-screen overflow-hidden bg-black">
      <ServiceWorkerRegister />
      <PaletteModal open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      {/* ═══════ Sidebar (desktop) ═══════ */}
      <aside className="hidden lg:flex w-56 flex-col bg-black border-r border-white/5 shrink-0">
        {/* Logo */}
        <Link href="/" className="px-5 pt-6 pb-5 block">
          <div className="flex items-center gap-2.5">
            <img src="/propai-logo.svg" alt="PropAI" className="w-10 h-10" />
            <div>
              <div className="text-[15px] font-bold text-white tracking-tight leading-none">PropAI</div>
              <div className="text-[9px] text-zinc-400 uppercase tracking-[0.15em] font-medium mt-0.5">Broker OS</div>
            </div>
          </div>
        </Link>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Sidebar navigation">
          {navSections.map((section) => (
            <div key={section.title} className="mb-4">
              <div className="px-2 mb-1.5 text-[9px] font-bold text-zinc-500 uppercase tracking-[0.15em]">
                {section.title}
              </div>
              {section.items.map((item) => {
                const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                const Icon = item.icon;
                return (
                  <button
                    key={item.href}
                    onClick={() => router.push(item.href)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-100 mb-0.5 ${
                      active
                        ? "bg-white/5 text-white"
                        : "text-zinc-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? "text-blue-400" : ""}`} strokeWidth={1.5} />
                    <span className="truncate">{item.label}</span>
                    {active && <div className="ml-auto w-1 h-1 rounded-full bg-blue-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Bottom Status */}
        <div className="px-4 py-3 border-t border-white/5 space-y-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
          >
            <Search className="w-3.5 h-3.5 shrink-0" strokeWidth={1.5} />
            <span>Search</span>
            <kbd className="ml-auto text-[9px] bg-white/5 px-1.5 py-0.5 rounded text-zinc-500">⌘K</kbd>
          </button>
          <a
            href="/connections"
            className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg hover:bg-white/5 transition-colors group"
          >
            {waConnected ? (
              <div className="relative shrink-0">
                <Wifi className="w-3.5 h-3.5 text-emerald-400" strokeWidth={1.5} />
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              </div>
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-red-400 shrink-0" strokeWidth={1.5} />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-zinc-300 truncate">
                {waConnected ? (whatsapp?.phone || "WhatsApp Connected") : "WhatsApp Disconnected"}
              </div>
              {waConnected && whatsapp?.connected_since && (
                <div className="text-[10px] text-zinc-500 truncate">
                  Since {new Date(whatsapp.connected_since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              )}
            </div>
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${waConnected ? "bg-emerald-400" : "bg-red-400"}`} />
          </a>
        </div>
      </aside>

      {/* ═══════ Main Content ═══════ */}
      <main className="flex-1 flex flex-col overflow-hidden bg-black min-w-0">
        {/* ═══ Top Bar ═══ */}
        <div className="flex items-center gap-2 px-2 lg:px-5 py-1.5 lg:py-2 border-b border-white/5 bg-black/80 min-h-[40px] lg:min-h-[44px]">
          {/* Hamburger (mobile) */}
          <button
            onClick={toggleDrawer}
            className="lg:hidden p-1.5 -ml-1 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
          >
            {drawerOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          {/* Connection status */}
          <div className="flex items-center gap-1.5 min-w-0">
            {offline && (
              <span className="flex items-center gap-1 text-[10px] text-red-400 font-semibold">
                <WifiOff className="w-3 h-3" strokeWidth={1.5} />
                Offline
              </span>
            )}
            <a href="/connections" className={`flex items-center gap-1 text-[11px] lg:text-[12px] font-semibold transition-colors ${waConnected ? "text-emerald-300" : "text-amber-300 hover:text-amber-200"}`}>
              <span className={`w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full ${waConnected ? "bg-emerald-400 animate-pulse" : "bg-amber-400"}`} />
              <span className="hidden sm:inline">{waConnected ? "Connected" : "Disconnected"}</span>
            </a>
          </div>
          {waConnected && whatsapp?.phone && (
            <span className="text-[10px] lg:text-[11px] text-zinc-500 font-mono truncate max-w-[120px] lg:max-w-none">{whatsapp.phone}</span>
          )}
          <div className="flex-1" />
          <a href="/connections" className="text-[9px] text-zinc-500 hover:text-zinc-300 uppercase tracking-wider transition-colors shrink-0">
            Settings
          </a>
        </div>

        {/* Page content */}
        <div className="flex-1 overflow-y-auto text-white">
          {children}
        </div>
      </main>

      {/* ═══════ Bottom Navigation (mobile) ═══════ */}
      <BottomNav onTabChange={setLastTab} />

      {/* Install Prompt */}
      <InstallPrompt />
    </div>
  );
}

function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-black text-white min-h-screen">
      {children}
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLanding = pathname === "/" || pathname === "/how-it-works";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#000000" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="PropAI" />
        <link rel="icon" type="image/svg+xml" href="/propai-logo.svg" />
        <link rel="apple-touch-icon" href="/pwa-192x192.png" />
        <link rel="manifest" href="/manifest" />
        <meta name="application-name" content="PropAI" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className={isLanding ? "" : "lg:overflow-hidden"}>
        {isLanding ? (
          <LandingLayout>{children}</LandingLayout>
        ) : (
          <LayoutProvider>
            <AppShell>{children}</AppShell>
          </LayoutProvider>
        )}
      </body>
    </html>
  );
}
