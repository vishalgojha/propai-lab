"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import "./globals.css";
import { getConnectionState, getWhatsAppStatus, getRaw, ConnectionState, WhatsAppStatus, searchMessages, getCompanionConfig, CompanionConfig, getProfile } from "@/lib/api";
import { classifyFormatIssue } from "@/lib/format-issues";
import {
  MessageSquare,
  BarChart3,
  Search,
  Briefcase,
  Brain,
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
  LogOut,
  Menu,
  X,
  Shield,
  AlertTriangle,
} from "lucide-react";
import { AuthProvider, useAuth } from "@/lib/AuthProvider";
import { LayoutProvider, useLayout } from "@/hooks/useLayout";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { BottomNav } from "@/components/layout/BottomNav";
import { MobileDrawer } from "@/components/layout/MobileDrawer";
import { InstallPrompt } from "@/components/layout/InstallPrompt";
import { ServiceWorkerRegister } from "@/components/layout/ServiceWorkerRegister";

const navSections = [
  {
    title: "Market",
    items: [
      { href: "/inbox", label: "Market Inbox", icon: MessageSquare },
      { href: "/whatsapp-groups", label: "WhatsApp Groups", icon: MessageSquare },
      { href: "/format-issues", label: "Format Issues", icon: AlertTriangle },
      { href: "/chat", label: "AI Chat", icon: Brain },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/clients", label: "My Clients", icon: UserCheck },
      { href: "/deals", label: "My Deals", icon: TrendingUp },
    ],
  },
  {
    title: "Settings",
    items: [
      { href: "/connections", label: "Connect WhatsApp", icon: Wifi },
      { href: "/audit", label: "WhatsApp Audit", icon: MessageSquare },
      { href: "/profile", label: "My Profile", icon: UserCheck },
      { href: "/profile/team", label: "Team", icon: UserCog },
      { href: "/settings/privacy", label: "Privacy", icon: Shield },
      { href: "/profile/billing", label: "Billing", icon: TrendingUp },
      { href: "/waba", label: "WABA API", icon: Key },
      { href: "/workspace/llm-providers", label: "AI Providers", icon: Radar },
      { href: "/trainer", label: "AI Learning", icon: GraduationCap },
      { href: "/usage", label: "Usage", icon: BarChart3 },
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
  const { user, loading: authLoading } = useAuth();
  const isMobile = useIsMobile();
  const { drawerOpen, setDrawerOpen, toggleDrawer, setLastTab } = useLayout();
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [offline, setOffline] = useState(false);
  const [profile, setProfile] = useState<{ auth_user_id?: string; phone: string; first_name: string; last_name?: string; email?: string; city?: string } | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [formatIssueCount, setFormatIssueCount] = useState(0);
  const [wabaConfig, setWabaConfig] = useState<CompanionConfig | null>(null);
  const { signOut: authSignOut } = useAuth();

  // Read profile from localStorage; if missing, try to hydrate from server
  useEffect(() => {
    const readProfile = () => {
      const s = localStorage.getItem("propai_profile");
      if (s) {
        try {
          const parsed = JSON.parse(s);
          setProfile(parsed?.auth_user_id === user?.id ? parsed : null);
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
      setProfileLoaded(true);
    };
    readProfile();
    window.addEventListener("storage", readProfile);
    window.addEventListener("propai_profile_updated", readProfile);
    return () => {
      window.removeEventListener("storage", readProfile);
      window.removeEventListener("propai_profile_updated", readProfile);
    };
  }, [user?.id]);

  // Hydrate localStorage profile from server when missing
  useEffect(() => {
    if (!user || profile) return;
    const phone = user.phone || "";
    if (!phone && !user.id) return;
    let cancelled = false;
    getProfile(phone, user.id).then((data: any) => {
      if (cancelled) return;
      if (data && data.first_name) {
        const hydrated = {
          auth_user_id: user.id,
          phone: data.phone || phone,
          first_name: data.first_name || "",
          last_name: data.last_name || "",
          email: data.email || user.email || "",
          city: data.city || "",
        };
        localStorage.setItem("propai_profile", JSON.stringify(hydrated));
        window.dispatchEvent(new Event("propai_profile_updated"));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user, profile]);

  const waConnected = conn?.connected ?? null;
  const waStale = conn?.status_stale ?? false;

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.replace(`/auth/login?next=${encodeURIComponent(pathname || "/dashboard")}`);
      return;
    }
    if (!profileLoaded) return;
  }, [authLoading, user, profileLoaded, pathname, router]);

  const handleSignOut = useCallback(async () => {
    localStorage.removeItem("propai_profile");
    setProfile(null);
    await authSignOut();
    router.replace("/auth/login");
  }, [authSignOut, router]);

  useEffect(() => {
    if (authLoading || !user) return;
    const load = async () => {
      try {
        const [c, w, cfg] = await Promise.all([getConnectionState(), getWhatsAppStatus(), getCompanionConfig().catch(() => null)]);
        setConn(c);
        setWhatsapp(w);
        if (cfg) setWabaConfig(cfg);
      } catch {}
    };
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [authLoading, user]);

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    getRaw(150, 0)
      .then((messages) => {
        if (!cancelled) setFormatIssueCount(messages.filter((message) => classifyFormatIssue(message)).length);
      })
      .catch(() => {
        if (!cancelled) setFormatIssueCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoading, user]);

  // PWA manifest link (static in RootLayout, this is for dynamic fallback)
  useEffect(() => {
    if (!document.querySelector('link[rel="manifest"]')) {
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = "/manifest";
      document.head.appendChild(link);
    }
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

  const profileRequired = !profile && pathname !== "/profile";

  if (authLoading || !user || !profileLoaded) {
    return null;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-black">
      <ServiceWorkerRegister />
      <PaletteModal open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onOpenPalette={() => setPaletteOpen(true)}
        formatIssueCount={formatIssueCount}
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
                const showFormatBadge = item.href === "/format-issues" && formatIssueCount > 0;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={true}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium transition-all duration-100 mb-0.5 ${
                      active
                        ? "bg-white/5 text-white"
                        : "text-zinc-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${active ? "text-blue-400" : ""}`} strokeWidth={1.5} />
                    <span className="truncate">{item.label}</span>
                    {showFormatBadge && (
                      <span className="ml-auto rounded-full border border-amber-500/20 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
                        {formatIssueCount > 99 ? "99+" : formatIssueCount}
                      </span>
                    )}
                    {active && <div className={`${showFormatBadge ? "ml-1" : "ml-auto"} w-1 h-1 rounded-full bg-blue-400 shrink-0`} />}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Profile Section */}
        {profile && (
          <div className="px-4 py-3 border-t border-white/5">
            <div className="flex items-center gap-2">
              <button onClick={() => router.push("/profile")}
                className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-white/5 transition-colors text-left">
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400 text-xs font-bold shrink-0">
                  {profile.first_name?.charAt(0)?.toUpperCase() || "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-semibold text-white truncate">
                    {profile.first_name}{profile.last_name ? ` ${profile.last_name}` : ""}
                  </div>
                  {profile.city && <div className="text-[10px] text-zinc-500 truncate">{profile.city}</div>}
                </div>
              </button>
              <button
                onClick={handleSignOut}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                aria-label="Log out"
                title="Log out"
              >
                <LogOut className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        )}

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
            {waConnected === null ? (
              <div className="relative shrink-0">
                <Wifi className="w-3.5 h-3.5 text-zinc-500" strokeWidth={1.5} />
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-zinc-500 rounded-full animate-pulse" />
              </div>
            ) : waConnected ? (
              <div className="relative shrink-0">
                <Wifi className={`w-3.5 h-3.5 ${waStale ? "text-amber-400" : "text-emerald-400"}`} strokeWidth={1.5} />
                <span className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full animate-pulse ${waStale ? "bg-amber-400" : "bg-emerald-400"}`} />
              </div>
            ) : (
              <WifiOff className="w-3.5 h-3.5 text-red-400 shrink-0" strokeWidth={1.5} />
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-zinc-300 truncate">
                {waConnected === null
                  ? "Checking WhatsApp"
                  : waConnected
                    ? (waStale ? (whatsapp?.phone || "WhatsApp Connected") : (whatsapp?.phone || "WhatsApp Connected"))
                    : "WhatsApp Disconnected"}
              </div>
              {waConnected && whatsapp?.connected_since && (
                <div className="text-[10px] text-zinc-500 truncate">
                  {waStale ? "Reconnecting quietly" : `Since ${new Date(whatsapp.connected_since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                </div>
              )}
            </div>
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${waConnected === null ? "bg-zinc-500" : waConnected ? (waStale ? "bg-amber-400" : "bg-emerald-400") : "bg-red-400"}`} />
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
            <a href="/connections" className={`flex items-center gap-1 text-[11px] lg:text-[12px] font-semibold transition-colors ${waConnected === null ? "text-zinc-400 hover:text-zinc-300" : waConnected ? (waStale ? "text-amber-300 hover:text-amber-200" : "text-emerald-300") : "text-amber-300 hover:text-amber-200"}`}>
              <span className={`w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full ${waConnected === null ? "bg-zinc-500" : waConnected ? (waStale ? "bg-amber-400 animate-pulse" : "bg-emerald-400 animate-pulse") : "bg-amber-400"}`} />
              <span className="hidden sm:inline">
                {waConnected === null ? "Checking" : waConnected ? (waStale ? "Reconnecting" : "Connected") : "Disconnected"}
              </span>
            </a>
          </div>
          {waConnected && whatsapp?.phone && (
            <span className="text-[10px] lg:text-[11px] text-zinc-500 font-mono truncate max-w-[120px] lg:max-w-none">{whatsapp.phone}</span>
          )}
          {wabaConfig?.outbound_allowed && (
            <a href="/waba" className="flex items-center gap-1 text-[10px] lg:text-[11px] font-semibold text-emerald-300 hover:text-emerald-200 transition-colors" title="PropAI Official WABA — Connected">
              <span className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="hidden md:inline">WABA Connected</span>
            </a>
          )}
          <div className="flex-1" />
          <button
            onClick={handleSignOut}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>

        {/* Page content */}
        <div className="flex-1 min-h-0 overflow-y-auto text-white relative">
          {profileRequired && (
            <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm px-6">
              <div className="max-w-sm text-center">
                <div className="text-lg font-bold text-white mb-2">Profile incomplete</div>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  You will not be able to access other pages unless the profile is fully done.
                </p>
                <a
                  href="/profile"
                  className="mt-5 inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  Complete your profile
                </a>
              </div>
            </div>
          )}
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
  const isAuth = pathname.startsWith("/auth");
  const isMcpAuthorize = pathname === "/mcp-authorize";
  const isPublicShare = pathname.startsWith("/share/");
  const isStandalone = isLanding || isAuth || isMcpAuthorize || isPublicShare;

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
        <link rel="manifest" href="/manifest.json" />
        <meta name="application-name" content="PropAI" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className={isStandalone ? "" : "lg:overflow-hidden"}>
        {isStandalone ? (
          <LandingLayout>{children}</LandingLayout>
        ) : (
          <LayoutProvider>
            <AuthProvider>
              <AppShell>{children}</AppShell>
            </AuthProvider>
          </LayoutProvider>
        )}
      </body>
    </html>
  );
}
