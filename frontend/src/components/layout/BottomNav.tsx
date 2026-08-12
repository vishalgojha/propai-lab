"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  MessageSquare,
  UserCheck,
  Wifi,
} from "lucide-react";

const tabs = [
  { href: "/inbox", label: "Inbox", icon: MessageSquare },
  { href: "/clients", label: "Clients", icon: UserCheck },
  { href: "/connections", label: "Connect", icon: Wifi },
];

export function BottomNav({ onTabChange }: { onTabChange?: (href: string) => void }) {
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
        {tabs.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href || (href !== "/" && pathname.startsWith(href));
          return (
            <button
              key={href}
              onClick={() => {
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
      </div>
    </nav>
  );
}
