"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import "./globals.css";
import { getConnectionState, getWhatsAppStatus, ConnectionState, WhatsAppStatus, searchMessages } from "@/lib/api";

const navSections = [
  {
    title: "My Business",
    items: [
      { href: "/connections", label: "Connection Center", icon: "🔌" },
      { href: "/inbox", label: "Market Inbox", icon: "💬" },
      { href: "/my/inventory", label: "My Inventory", icon: "🏠" },
      { href: "/my/buyers", label: "My Buyers", icon: "🙋" },
      { href: "/promotions", label: "Promotions", icon: "📣" },
      { href: "/people", label: "People", icon: "📇" },
    ],
  },
  {
    title: "Market",
    items: [
      { href: "/knowledge", label: "Knowledge Base", icon: "📚" },
      { href: "/requirements", label: "Extracted Requirements", icon: "📋" },
      { href: "/brokers", label: "Brokers", icon: "🤝" },
      { href: "/groups", label: "Groups", icon: "👥" },
      { href: "/market", label: "Markets", icon: "🗺️" },
    ],
  },
  {
    title: "Intelligence",
    items: [
      { href: "/", label: "Dashboard", icon: "📊" },
      { href: "/intelligence", label: "Market Actions", icon: "🧠" },
      { href: "/chat?tab=review", label: "Review Center", icon: "✅" },
      { href: "/chat", label: "AI Chat", icon: "🤖" },
      { href: "/audit", label: "WhatsApp Audit", icon: "🔬" },
      { href: "/trainer", label: "Knowledge Trainer", icon: "🎓" },
      { href: "/settings", label: "Settings", icon: "⚙" },
    ],
  },
];

const QUICK_ACTIONS = [
  { label: "2 BHK under 2 Cr", icon: "🏠", query: "2 bhk" },
  { label: "1 BHK rental", icon: "🔑", query: "1 bhk" },
  { label: "Bandra market listings", icon: "📍", query: "bandra" },
  { label: "Commercial offices", icon: "🏢", query: "commercial" },
  { label: "Active brokers", icon: "🤝", query: "" },
  { label: "Recent extracted requirements", icon: "📋", query: "" },
];

function PaletteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, any[]> | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Flatten grouped results for keyboard navigation
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
      else navigate(`/chat?q=${encodeURIComponent(query)}`);
    }
    else if (e.key === "Escape") onClose();
  }

  const GROUP_ICONS: Record<string, string> = {
    listings: "🏗️", requirements: "📋", brokers: "🤝", buildings: "🏢", markets: "🗺️", messages: "💬",
  };
  const GROUP_LABELS: Record<string, string> = {
    listings: "Parser Candidates", requirements: "Extracted Requirements", brokers: "Brokers", buildings: "Buildings", markets: "Markets", messages: "Messages",
  };

  function renderGroupItem(group: string, item: any, i: number, globalIdx: number) {
    let title = "", subtitle = "";
    if (group === "listings") {
      title = [item.bhk, item.building_name, item.micro_market].filter(Boolean).join(" · ");
      subtitle = `₹${Number(item.price || 0).toLocaleString()} · ${item.broker_name || ""} · ${item.observation_count || 1} posts`;
    } else if (group === "requirements") {
      title = [item.bhk, item.micro_market].filter(Boolean).join(" · ");
      subtitle = `${item.broker_name || ""} · wants ${item.intent?.toLowerCase()}`;
    } else if (group === "brokers") {
      title = item.name;
      subtitle = `${item.listing_count || 0} listings · ${item.requirement_count || 0} requirements · ${item.market_count || 0} markets`;
    } else if (group === "buildings") {
      title = item.name;
      subtitle = `${item.occurrence_count || 0} messages · ${item.broker_count || 0} brokers${item.micro_market ? ` · ${item.micro_market}` : ""}`;
    } else if (group === "markets") {
      title = item.micro_market;
      subtitle = `${item.observation_count || 0} posts · ${item.building_count || 0} buildings · ${item.broker_count || 0} brokers`;
    } else if (group === "messages") {
      title = (item.message || "").slice(0, 80);
      subtitle = `${item.group_name || ""} · ${item.sender || ""}`;
    }

    return (
      <button
        key={`${group}-${i}`}
        onClick={() => {
          if (group === "listings") navigate(`/search?q=${encodeURIComponent(item.building_name || item.micro_market || query)}`);
          else if (group === "requirements") navigate(`/requirements?q=${encodeURIComponent(item.micro_market || query)}`);
          else if (group === "brokers") navigate(`/brokers/${item.id || `?q=${encodeURIComponent(item.name)}`}`);
          else if (group === "buildings") navigate(`/search?q=${encodeURIComponent(item.name)}`);
          else if (group === "markets") navigate(`/market?q=${encodeURIComponent(item.micro_market)}`);
          else if (group === "messages") navigate(`/inbox?highlight=${item.id}`);
        }}
        className={`w-full flex items-start gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
          globalIdx === selectedIdx ? "bg-blue-600/20 border border-blue-500/30" : "hover:bg-[rgba(255,255,255,0.03)]"
        }`}
      >
        <span className="text-sm mt-0.5 shrink-0">{GROUP_ICONS[group] || "📄"}</span>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-white truncate">{title || "—"}</div>
          {subtitle && <div className="text-[10px] text-[#64748b] truncate mt-0.5">{subtitle}</div>}
        </div>
      </button>
    );
  }

  function renderResultGroups() {
    if (!results) return null;
    let globalIdx = -1;
    const groups = Object.entries(results).filter(([, items]) => items.length > 0);
    if (groups.length === 0) {
      return (
        <div className="text-center text-[#64748b] text-xs py-6">
          No results.{" "}
          <button onClick={() => navigate(`/chat?q=${encodeURIComponent(query)}`)} className="text-blue-400 hover:underline">
            Ask AI Chat instead →
          </button>
        </div>
      );
    }
    return groups.map(([group, items]) => {
      const icon = GROUP_ICONS[group] || "📄";
      const label = GROUP_LABELS[group] || group;
      return (
        <div key={group} className="mb-2">
          <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-1 px-2 flex items-center gap-1.5">
            <span>{icon}</span> {label} <span className="font-normal">({items.length})</span>
          </div>
          {items.slice(0, 4).map((item: any, i: number) => {
            globalIdx++;
            return renderGroupItem(group, item, i, globalIdx);
          })}
        </div>
      );
    });
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="fixed inset-0 bg-black/60" />
      <div
        className="relative bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-xl w-full max-w-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[rgba(255,255,255,0.06)]">
          <span className="text-[#64748b] text-sm">🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search extracted listings, requirements, brokers, buildings, markets..."
            className="flex-1 bg-transparent text-sm text-white placeholder-[#64748b] outline-none"
          />
          <kbd className="text-[10px] text-[#64748b] border border-[rgba(255,255,255,0.08)] px-1.5 py-0.5 rounded">ESC</kbd>
        </div>

        {/* Quick actions (shown when no query) */}
        {!query.trim() && (
          <div className="p-3">
            <div className="text-[10px] font-semibold text-[#64748b] uppercase tracking-wider mb-2 px-1">Quick Actions</div>
            <div className="grid grid-cols-2 gap-1.5">
              <button onClick={() => navigate("/knowledge")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>📚</span> Knowledge Base
              </button>
              <button onClick={() => navigate("/inbox")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>💬</span> Market Inbox
              </button>
              <button onClick={() => navigate("/requirements")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>📋</span> Extracted Requirements
              </button>
              <button onClick={() => navigate("/brokers")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>🤝</span> Active Brokers
              </button>
              <button onClick={() => navigate("/market")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>🗺️</span> Markets
              </button>
              <button onClick={() => navigate("/chat")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>🤖</span> Ask AI Chat
              </button>
              <button onClick={() => navigate("/audit")} className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left">
                <span>🔬</span> WhatsApp Audit
              </button>
            </div>
            <div className="grid grid-cols-2 gap-1.5 mt-1.5">
              {QUICK_ACTIONS.map((a) => (
                <button key={a.label} onClick={() => setQuery(a.query)}
                  className="flex items-center gap-2 text-xs text-[#94a3b8] hover:text-white hover:bg-[rgba(255,255,255,0.04)] rounded-lg px-2.5 py-2 transition-colors text-left"
                >
                  <span>{a.icon}</span> {a.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Search results — grouped by entity type */}
        {query.trim() && (
          <div className="max-h-96 overflow-y-auto p-2">
            {results === null ? (
              <div className="text-center text-[#64748b] text-xs py-6">Searching...</div>
            ) : (
              renderResultGroups()
            )}
          </div>
        )}

        <div className="px-4 py-2 border-t border-[rgba(255,255,255,0.06)] flex gap-3 text-[10px] text-[#64748b]">
          <span>↑↓ Navigate</span>
          <span>↵ Open</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [wa, setWA] = useState<WhatsAppStatus | null>(null);
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const denseRoutes = ["/inbox", "/extractions", "/requirements", "/groups"];
  const defaultSidebarOpen = !denseRoutes.some((route) => pathname.startsWith(route));
  const sidebarOpen = sidebarOverride ?? defaultSidebarOpen;

  // Global Ctrl+K / Cmd+K
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((p) => !p);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    async function poll() {
      try {
        const c = await getConnectionState();
        setConn(c);
        const w = await getWhatsAppStatus();
        setWA(w);
      } catch { /* ignore */ }
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const connected = conn?.connected ?? false;
  const dotColor = connected ? "bg-green-500" : "bg-red-500";
  const label = connected ? `WhatsApp Connected${wa?.phone ? ` • ${wa.phone}` : ""}` : "Disconnected";

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icon.png" />
        <title>PropAI</title>
      </head>
      <body className="flex min-h-screen">
        <PaletteModal open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        {sidebarOpen && (
          <aside className="w-64 border-r border-[rgba(255,255,255,0.06)] p-4 flex flex-col gap-1 shrink-0 bg-[#0a0e14]">
            <a href="/" className="mb-5 flex items-center gap-3 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3 py-3 no-underline hover:border-[rgba(62,232,138,0.35)] hover:bg-[rgba(62,232,138,0.06)]">
              <img src="/icon.png" alt="PropAI" className="h-9 w-9 shrink-0 rounded-lg" />
              <div className="min-w-0">
                <div className="text-[15px] font-bold leading-none text-[#e2e8f0]">PropAI</div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-[#64748b]">Broker OS</div>
              </div>
            </a>
            <a href="/companion" className="sidebar-link mb-3 bg-[rgba(62,232,138,0.08)] text-[#3EE88A]">
              <span>📱</span>
              <span>PropAI Companion</span>
            </a>
            {navSections.map((section) => (
              <div key={section.title} className="mb-3">
                <div className="px-3 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-[#64748b]">
                  {section.title}
                </div>
                {section.items.map((item) => (
                  <a key={item.href} href={item.href} className="sidebar-link">
                    <span>{item.icon}</span>
                    <span>{item.label}</span>
                  </a>
                ))}
              </div>
            ))}
            <button
              onClick={() => setPaletteOpen(true)}
              className="sidebar-link text-[#64748b] mt-2 border-t border-[rgba(255,255,255,0.06)] pt-3"
            >
              <span>🔍</span>
              <span className="flex-1 text-left">Search</span>
              <kbd className="text-[10px] text-[#64748b] border border-[rgba(255,255,255,0.08)] px-1 rounded">⌘K</kbd>
            </button>
          </aside>
        )}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="flex items-center gap-3 px-6 py-3 border-b border-[rgba(255,255,255,0.06)]">
            <button
              onClick={() => setSidebarOverride(!sidebarOpen)}
              className="text-[#94a3b8] hover:text-white text-lg leading-none mr-1"
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            >
              {sidebarOpen ? "◀" : "▶"}
            </button>
            <span className={`w-2 h-2 rounded-full ${dotColor}`} />
            <span className="text-sm text-[#94a3b8]">{label}</span>
            <button
              onClick={() => setPaletteOpen(true)}
              className="ml-auto flex items-center gap-2 text-xs text-[#64748b] hover:text-white border border-[rgba(255,255,255,0.06)] rounded-lg px-3 py-1.5"
            >
              <span>🔍</span>
              Quick search...
              <kbd className="text-[10px] text-[#64748b] border border-[rgba(255,255,255,0.08)] px-1 rounded">⌘K</kbd>
            </button>
          </header>
          <main className="flex-1 p-6 overflow-auto">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
