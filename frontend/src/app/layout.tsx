"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import "./globals.css";
import { getConnectionState, getWhatsAppStatus, ConnectionState, WhatsAppStatus } from "@/lib/api";

const navItems = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/inbox", label: "Messages", icon: "💬" },
  { href: "/extractions", label: "Inventory", icon: "🏗️" },
  { href: "/requirements", label: "Requirements", icon: "📋" },
  { href: "/brokers", label: "Brokers", icon: "🤝" },
  { href: "/groups", label: "Groups", icon: "👥" },
  { href: "/market", label: "Markets", icon: "🗺️" },
  { href: "/search", label: "Search", icon: "🔍" },
  { href: "/chat", label: "AI Review", icon: "🤖" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [conn, setConn] = useState<ConnectionState | null>(null);
  const [wa, setWA] = useState<WhatsAppStatus | null>(null);
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const denseRoutes = ["/inbox", "/extractions", "/requirements", "/groups", "/search"];
  const defaultSidebarOpen = !denseRoutes.some((route) => pathname.startsWith(route));
  const sidebarOpen = sidebarOverride ?? defaultSidebarOpen;

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
        <title>PropAI</title>
      </head>
      <body className="flex min-h-screen">
        {sidebarOpen && (
          <aside className="w-56 border-r border-[rgba(255,255,255,0.06)] p-4 flex flex-col gap-1 shrink-0 bg-[#0a0e14]">
            <div className="text-lg font-bold mb-6 px-3 text-[#e2e8f0]">PropAI</div>
            {navItems.map((item) => (
              <a key={item.href} href={item.href} className="sidebar-link">
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </a>
            ))}
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
          </header>
          <main className="flex-1 p-6 overflow-auto">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
