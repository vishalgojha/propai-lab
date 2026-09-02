"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, X, RefreshCw } from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";
import { getBuildHint } from "@/lib/buildInfo";

type NavItem = {
  href: string;
  label: string;
  external?: boolean;
  children?: { href: string; label: string }[];
};

const baseNavSections = [
  {
    title: "WhatsApp",
    items: [
      { href: "/whatsapp?tab=numbers", label: "WhatsApp" },
      { href: "/inbox", label: "Market Inbox" },
      { href: "/chat", label: "Search & Chat" },
    ],
  },
  {
    title: "Workspace",
    items: [
      { href: "/clients", label: "My Clients" },
      { href: "/crm", label: "Private CRM" },
      { href: "/account?tab=google-drive", label: "Google Drive" },
      { href: "/deals", label: "My Deals" },
      { href: "/auto-matched", label: "Auto Matched" },
    ],
  },
  {
    title: "Growth",
    items: [
      { href: "/social-flow", label: "Realtor Ads Studio" },
    ],
  },
  {
    title: "Settings",
    items: [
      { href: "/account?tab=profile", label: "Account" },
      { href: "/reports?tab=usage", label: "Reports" },
      { href: "/workspace/brokers", label: "Hidden Brokers" },
    ],
  },
];

export function MobileDrawer({
  open,
  onClose,
  isSuperAdmin,
  whatsappConnected,
  whatsappPhone,
  extractionLabel,
  extractionWarning,
  buildLabel,
}: {
  open: boolean;
  onClose: () => void;
  isSuperAdmin: boolean;
  whatsappConnected: boolean | null;
  whatsappPhone?: string | null;
  extractionLabel: string;
  extractionWarning: boolean;
  buildLabel: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { signOut, user } = useAuth();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState<{ auth_user_id?: string; phone: string; first_name: string; last_name?: string; city?: string } | null>(null);
  const buildHint = getBuildHint();
  const navSections = isSuperAdmin
    ? [
        ...baseNavSections,
        {
          title: "",
          items: [
            { href: "/brokers", label: "Broker Profiles" },
            { href: "/admin", label: "Super Admin" },
            { href: "/admin/pipeline-health?tab=providers", label: "Pipeline Health" },
          ],
        },
      ]
    : baseNavSections;

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

  function navigateItem(item: NavItem) {
    if (item.external) {
      window.open(item.href, "_blank", "noopener,noreferrer");
      onClose();
      return;
    }
    navigate(item.href);
  }

  async function handleSignOut() {
    localStorage.removeItem("propai_profile");
    await signOut();
    onClose();
    // Force a fresh document after logout so the authenticated app shell
    // cannot survive the transition with stale client-side chunks.
    window.location.replace(`/auth/login?logged_out=${Date.now()}`);
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
        className={`propai-sidebar fixed inset-y-0 left-0 z-[700] w-72 max-w-[85vw] flex flex-col border-r border-white/[0.07] transition-transform duration-200 ease-out lg:hidden ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-5 pb-4 border-b border-white/5">
          <Link href="/dashboard" onClick={onClose} className="flex items-center gap-2.5" aria-label="PropAI workspace home">
            <img src="/propai-logo.svg" alt="" className="propai-brand-mark h-8 w-8" />
            <div>
              <div className="text-sm font-bold text-white tracking-tight leading-none">PropAI</div>
              <div className="text-[8px] text-zinc-500 uppercase tracking-[0.15em] font-medium mt-0.5">Broker OS</div>
            </div>
          </Link>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <a
          href="/whatsapp?tab=numbers"
          onClick={onClose}
          className="mx-3 mt-3 flex min-h-10 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 text-[11px] transition-colors hover:bg-white/[0.05]"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${whatsappConnected ? "bg-[#6B8E63]" : whatsappConnected === false ? "bg-red-400" : "bg-zinc-500"}`} />
          <span className="min-w-0 flex-1 truncate text-zinc-300">
            {whatsappConnected ? `WhatsApp · ${whatsappPhone || "Connected"}` : whatsappConnected === false ? "Connect WhatsApp" : "Checking WhatsApp"}
          </span>
          <span className={`shrink-0 truncate ${extractionWarning ? "text-amber-300" : "text-zinc-600"}`}>{extractionLabel}</span>
          <span className="shrink-0 border-l border-white/10 pl-2 font-mono text-[10px] text-zinc-500" title={buildHint}>{buildLabel}</span>
          <button
            type="button"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); window.location.reload(); }}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-white"
            aria-label="Reload the page"
            title="Reload the page"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </a>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {navSections.map((section) => (
            <div key={section.title} className="mb-5">
              {section.title && <div className="px-2 mb-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-[0.15em]">{section.title}</div>}
              {section.items.map((item: NavItem) => {
                const itemPath = item.href.split("?")[0];
                const active =
                  pathname === itemPath ||
                  (itemPath !== "/" && pathname.startsWith(itemPath));
                const isPrimary = item.label === "Search & Chat" || item.label === "My Deals";
                return (
                  <div key={item.href} className="mb-0.5">
                    <button
                      onClick={() => navigateItem(item)}
                      data-active={active}
                      data-priority={isPrimary}
                      className={`propai-nav-link w-full text-left px-2.5 py-2 rounded-lg transition-all duration-150 ${isPrimary ? "text-sm font-semibold" : "text-sm font-medium"}`}
                    >
                      <span>{item.label}</span>
                      {item.href.startsWith("/whatsapp") && (
                        <span className={`float-right text-[10px] ${whatsappConnected ? "text-[#6B8E63]" : "text-zinc-600"}`}>
                          {whatsappConnected ? whatsappPhone || "Connected" : whatsappConnected === false ? "Offline" : "Checking"}
                        </span>
                      )}
                      {active && <span className="float-right text-[9px] font-semibold uppercase tracking-[.14em] text-accent">Live</span>}
                    </button>
                    {item.children && (
                      <div className="ml-4 mt-1 space-y-0.5">
                        {item.children.map((child) => {
                          const childActive = pathname === child.href || pathname.startsWith(`${child.href}/`);
                          return (
                            <button
                              key={child.href}
                              onClick={() => navigate(child.href)}
                              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
                                childActive ? "text-white" : "text-zinc-500 hover:text-zinc-300"
                              }`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${childActive ? "bg-[#6B8E63]" : "bg-zinc-700"}`} />
                              <span>{child.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
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
