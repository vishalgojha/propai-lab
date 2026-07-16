"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, X, Search } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";

const navSections = [
  {
    title: "Market",
    items: [
      { href: "/inbox", label: "Market Inbox" },
      { href: "/whatsapp-groups", label: "WhatsApp Groups" },
      { href: "/format-issues", label: "Format Issues" },
      { href: "/chat", label: "AI Chat" },
    ],
  },
  {
    title: "My Workspace",
    items: [
      { href: "/clients", label: "My Clients" },
      { href: "/deals", label: "My Deals" },
    ],
  },
  {
    title: "Settings",
    items: [
      { href: "/connections", label: "Connect WhatsApp" },
      { href: "/audit", label: "WhatsApp Audit" },
      { href: "/profile", label: "My Profile" },
      { href: "/profile/team", label: "Team" },
      { href: "/profile/billing", label: "Billing" },
      { href: "/waba", label: "WABA API" },
      { href: "/workspace/llm-providers", label: "AI Providers" },
      { href: "/trainer", label: "AI Learning" },
      { href: "/usage", label: "Usage" },
    ],
  },
];

export function MobileDrawer({
  open,
  onClose,
  onOpenPalette,
  formatIssueCount = 0,
}: {
  open: boolean;
  onClose: () => void;
  onOpenPalette: () => void;
  formatIssueCount?: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut, user } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<{ auth_user_id?: string; phone: string; first_name: string; last_name?: string; city?: string } | null>(null);

  useEffect(() => {
    const readProfile = () => {
      const stored = localStorage.getItem("propai_profile");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setProfile(parsed?.auth_user_id === user?.id ? parsed : null);
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
    };
    readProfile();
    window.addEventListener("storage", readProfile);
    window.addEventListener("propai_profile_updated", readProfile);
    return () => {
      window.removeEventListener("storage", readProfile);
      window.removeEventListener("propai_profile_updated", readProfile);
    };
  }, [user?.id]);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (open) window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  function navigate(href: string) {
    router.push(href);
    onClose();
  }

  async function handleSignOut() {
    localStorage.removeItem("propai_profile");
    await signOut();
    onClose();
    router.replace("/auth/login");
  }

  return (
    <>
      {/* Overlay */}
      <div
        ref={overlayRef}
        className={`fixed inset-0 z-[600] bg-black/60 backdrop-blur-sm transition-opacity duration-200 lg:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-[700] w-72 max-w-[85vw] flex flex-col bg-black border-r border-white/5 transition-transform duration-200 ease-out lg:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-5 pb-4 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <img src="/propai-logo.svg" alt="" className="h-8 w-8" />
            <div>
              <div className="text-sm font-bold text-white tracking-tight leading-none">PropAI</div>
              <div className="text-[8px] text-zinc-500 uppercase tracking-[0.15em] font-medium mt-0.5">Broker OS</div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search button */}
        <button
          onClick={() => { onClose(); onOpenPalette(); }}
          className="flex items-center gap-2 mx-3 mt-3 px-3 py-2.5 rounded-lg bg-white/5 text-sm text-zinc-400 hover:text-zinc-300 transition-colors"
        >
          <Search className="h-4 w-4" strokeWidth={1.5} />
          <span>Search</span>
          <kbd className="ml-auto text-[10px] text-zinc-600 bg-white/5 px-1.5 py-0.5 rounded">⌘K</kbd>
        </button>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navSections.map((section) => (
            <div key={section.title} className="mb-5">
              <div className="px-2 mb-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-[0.15em]">
                {section.title}
              </div>
              {section.items.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href));
                const showFormatBadge = item.href === "/format-issues" && formatIssueCount > 0;
                return (
                  <button
                    key={item.href}
                    onClick={() => navigate(item.href)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-sm font-medium transition-all duration-100 mb-0.5 ${
                      active
                        ? "bg-white/5 text-white"
                        : "text-zinc-400 hover:text-white hover:bg-white/5"
                    }`}
                  >
                    <span>{item.label}</span>
                    {showFormatBadge && (
                      <span className="float-right ml-2 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                        {formatIssueCount > 99 ? "99+" : formatIssueCount}
                      </span>
                    )}
                    {active && (
                      <span className="float-right mt-1 h-1.5 w-1.5 rounded-full bg-white" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Profile */}
        {profile && (
          <div className="px-4 py-3 border-t border-white/5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate("/profile")}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.03] text-sm font-semibold text-zinc-300">
                  {profile.first_name?.charAt(0)?.toUpperCase() || "?"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-white truncate">
                    {profile.first_name}{profile.last_name ? ` ${profile.last_name}` : ""}
                  </div>
                  {profile.city && <div className="text-[11px] text-zinc-500 truncate">{profile.city}</div>}
                </div>
              </button>
              <button
                onClick={handleSignOut}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                aria-label="Log out"
              >
                <LogOut className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
