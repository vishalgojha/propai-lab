"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import "./globals.css";
import { getConnectionState, getWhatsAppStatus, ConnectionState, WhatsAppStatus, searchMessages } from "@/lib/api";
import {
  MessageSquare,
  Users,
  BarChart3,
  BookOpen,
  Search,
  Settings,
  Zap,
  Building2,
  Briefcase,
  Brain,
  ClipboardCheck,
  GraduationCap,
  Radar,
  MapPin,
  Hash,
  ChevronRight,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";

const navSections = [
  {
    title: "Conversations",
    items: [
      { href: "/inbox", label: "Market Inbox", icon: MessageSquare },
      { href: "/audit", label: "Network Intel", icon: Radar },
    ],
  },
  {
    title: "Clients",
    items: [
      { href: "/my/buyers", label: "Buyers", icon: Users },
      { href: "/my/inventory", label: "Inventory", icon: Building2 },
      { href: "/brokers", label: "Brokers", icon: Briefcase },
      { href: "/requirements", label: "Requirements", icon: ClipboardCheck },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { href: "/", label: "Dashboard", icon: BarChart3 },
      { href: "/chat", label: "AI Chat", icon: Brain },
      { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
      { href: "/market", label: "Markets", icon: MapPin },
      { href: "/groups", label: "Groups", icon: Users },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/connections", label: "Connection", icon: Wifi },
      { href: "/trainer", label: "Trainer", icon: GraduationCap },
      { href: "/settings", label: "Settings", icon: Settings },
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
      <div className="w-full max-w-lg bg-[#0d1117] border border-[rgba(255,255,255,0.08)] rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
          <Search className="w-4 h-4 text-[#64748b]" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search properties, brokers, buildings..."
            className="flex-1 bg-transparent text-sm text-white placeholder-[#4a5568] outline-none"
          />
          <kbd className="text-[10px] text-[#4a5568] bg-[rgba(255,255,255,0.05)] px-1.5 py-0.5 rounded">ESC</kbd>
        </div>
        {results && (
          <div className="max-h-80 overflow-y-auto py-2">
            {Object.entries(results).map(([group, items]) => (
              <div key={group}>
                <div className="px-4 py-1.5 text-[10px] font-bold text-[#4a5568] uppercase tracking-wider">{group}</div>
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
                      className={`w-full text-left px-4 py-2 text-sm flex items-center gap-3 ${isSelected ? "bg-blue-500/10 text-white" : "text-[#94a3b8] hover:bg-[rgba(255,255,255,0.03)]"}`}
                    >
                      <span className="text-xs text-[#4a5568] w-4 text-right">{globalIdx + 1}</span>
                      <span className="truncate">{item.name || item.micro_market || item.building_name || item.broker_name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {flatItems.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-[#4a5568]">No results found</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  const waConnected = whatsapp?.connected;

  return (
    <html lang="en">
      <body>
        <PaletteModal open={paletteOpen} onClose={() => setPaletteOpen(false)} />

        <div className="flex h-screen overflow-hidden">
          {/* ═══════ Sidebar ═══════ */}
          <aside className="w-56 flex flex-col bg-[#090d12] border-r border-[rgba(255,255,255,0.04)]">
            {/* Logo */}
            <div className="px-5 pt-6 pb-5">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Zap className="w-3.5 h-3.5 text-white" />
                </div>
                <div>
                  <div className="text-[13px] font-bold text-white tracking-tight leading-none">PropAI</div>
                  <div className="text-[9px] text-[#4a5568] uppercase tracking-[0.15em] font-medium mt-0.5">Broker OS</div>
                </div>
              </div>
            </div>

            {/* Navigation */}
            <nav className="flex-1 overflow-y-auto px-3 pb-4">
              {navSections.map((section) => (
                <div key={section.title} className="mb-4">
                  <div className="px-2 mb-1.5 text-[9px] font-bold text-[#4a5568] uppercase tracking-[0.15em]">
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
                            ? "bg-[rgba(59,130,246,0.08)] text-white"
                            : "text-[#64748b] hover:text-[#94a3b8] hover:bg-[rgba(255,255,255,0.02)]"
                        }`}
                      >
                        <Icon className={`w-3.5 h-3.5 ${active ? "text-blue-400" : ""}`} strokeWidth={1.5} />
                        <span>{item.label}</span>
                        {active && <div className="ml-auto w-1 h-1 rounded-full bg-blue-400" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>

            {/* Bottom Status */}
            <div className="px-4 py-3 border-t border-[rgba(255,255,255,0.04)]">
              <button
                onClick={() => setPaletteOpen(true)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] text-[#4a5568] hover:text-[#94a3b8] hover:bg-[rgba(255,255,255,0.02)] transition-colors"
              >
                <Search className="w-3.5 h-3.5" strokeWidth={1.5} />
                <span>Search</span>
                <kbd className="ml-auto text-[9px] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 rounded text-[#4a5568]">⌘K</kbd>
              </button>
              <div className="flex items-center gap-2 px-2.5 py-1.5 mt-1">
                {waConnected ? (
                  <Wifi className="w-3 h-3 text-emerald-500" strokeWidth={1.5} />
                ) : (
                  <WifiOff className="w-3 h-3 text-red-500" strokeWidth={1.5} />
                )}
                <span className="text-[10px] text-[#4a5568]">
                  {waConnected ? "WhatsApp Connected" : "WhatsApp Disconnected"}
                </span>
              </div>
            </div>
          </aside>

          {/* ═══════ Main Content ═══════ */}
          <main className="flex-1 overflow-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
