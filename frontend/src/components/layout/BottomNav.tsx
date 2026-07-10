"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  MessageSquare,
  UserCheck,
  Brain,
  Wifi,
} from "lucide-react";

const tabs = [
  { href: "/inbox", label: "Inbox", icon: MessageSquare },
  { href: "/clients", label: "Clients", icon: UserCheck },
  { href: "/chat", label: "AI Chat", icon: Brain },
  { href: "/connections", label: "Connect", icon: Wifi },
];

export function BottomNav({ onTabChange }: { onTabChange?: (href: string) => void }) {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/5 bg-black/95 backdrop-blur-lg lg:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      role="navigation"
      aria-label="Mobile navigation"
    >
      <div className="flex items-center justify-around px-2 py-1">
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
              className={`flex flex-col items-center gap-0.5 px-3 py-2 min-w-0 rounded-xl transition-colors ${
                active
                  ? "text-propai-green"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              aria-current={active ? "page" : undefined}
              aria-label={label}
            >
              <Icon className="h-5 w-5" strokeWidth={active ? 2 : 1.5} />
              <span className="text-[10px] font-medium leading-tight">
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
