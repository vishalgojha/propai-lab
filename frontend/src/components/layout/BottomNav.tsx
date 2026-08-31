"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  House,
  MessageCircle,
  Sparkles,
  Wifi,
  Menu,
} from "lucide-react";

const tabs = [
  { href: "/dashboard", label: "Home", icon: House },
  { href: "/chat", label: "Chat", icon: MessageCircle },
  { href: "#copilot", label: "Copilot", icon: Sparkles, action: "copilot" },
  { href: "/whatsapp?tab=numbers", label: "Connect", icon: Wifi },
];

export function BottomNav({ onTabChange, onMenu }: { onTabChange?: (href: string) => void; onMenu?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav
      className="propai-status-rail fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.07] lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      role="navigation"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around px-1 py-0.5">
        {tabs.map(({ href, label, icon: Icon, action }) => {
          const routePath = href.split("?")[0];
          const active =
            pathname === routePath || (routePath !== "/" && pathname.startsWith(routePath));
          return (
            <button
              key={href}
              onClick={() => {
                if (action === "copilot") {
                  window.dispatchEvent(new CustomEvent("propai:open-copilot"));
                  return;
                }
                onTabChange?.(href);
                router.push(href);
              }}
              className={`relative flex flex-col items-center gap-0.5 px-4 py-2 min-w-0 rounded-xl transition-colors ${
                active
                  ? "text-propai-green"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              aria-current={active ? "page" : undefined}
              aria-label={label}
            >
              {active && <span className="absolute -top-px h-0.5 w-7 rounded-full bg-accent shadow-[0_0_10px_rgba(54,229,139,.55)]" />}
              <Icon className="h-4 w-4" strokeWidth={active ? 2 : 1.5} />
              <span className="text-[9px] font-medium leading-tight">
                {label}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={onMenu}
          className="relative flex min-w-0 flex-col items-center gap-0.5 rounded-xl px-3 py-2 text-zinc-500 transition-colors hover:text-zinc-300"
          aria-label="Open menu"
        >
          <Menu className="h-4 w-4" strokeWidth={1.5} />
          <span className="text-[9px] font-medium leading-tight">Menu</span>
        </button>
      </div>
    </nav>
  );
}
