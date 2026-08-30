"use client";

import Link from "next/link";
import { useState } from "react";

const NAV_LINKS = [
  { href: "/map", label: "Map" },
  { href: "/localities", label: "Localities" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

function Wordmark() {
  return (
    <span className="flex items-center gap-2.5 transition-all duration-base hover:scale-[1.02] active:scale-[0.98]">
      <img src="/propai-logo.svg?v=3" alt="" aria-hidden="true" className="h-10 w-10" />
      <span className="text-2xl font-bold tracking-tight text-[var(--asphalt)]">
        Prop<span className="text-[var(--monsoon-teal)]">AI</span>
      </span>
    </span>
  );
}

export type SiteHeaderProps = {
  backHref?: string;
  backLabel?: string;
};

export default function SiteHeader({ backHref, backLabel }: SiteHeaderProps) {
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header sticky top-0 z-50 border-b border-[var(--line-on-light)] bg-[var(--mist)]/90 backdrop-blur">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-20 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="PropAI home" className="flex items-center" onClick={() => setOpen(false)}>
            <Wordmark />
          </Link>
          {backHref && (
            <Link
              href={backHref}
              className="hidden items-center gap-1.5 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--monsoon-teal)] sm:inline-flex"
            >
              <span aria-hidden="true">←</span> {backLabel ?? "Back"}
            </Link>
          )}
        </div>

        <nav className="hidden lg:flex items-center gap-8" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[15px] text-[var(--text-secondary)] transition-all duration-base hover:scale-[1.02] hover:text-[var(--monsoon-teal)] active:scale-[0.98]"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden lg:flex items-center gap-4">
          <Link
            href="/contact"
            className="text-[15px] text-[var(--text-secondary)] transition-all duration-base hover:scale-[1.02] hover:text-[var(--monsoon-teal)] active:scale-[0.98]"
          >
            Broker login
          </Link>
          <Link
            href="/contact"
            className="site-primary-cta inline-flex items-center rounded-full bg-[var(--signal-lime-on-mist)] px-4 py-2 text-sm font-semibold text-[var(--mist)] transition-all duration-base hover:bg-[var(--monsoon-teal)] hover:scale-[1.02] active:scale-[0.98]"
          >
            Get started
          </Link>
        </div>

        {/* Mobile menu toggle */}
        <div className="flex items-center gap-2 lg:hidden">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--line-on-light)] text-[var(--asphalt)] transition-colors hover:border-[var(--monsoon-teal)] hover:text-[var(--monsoon-teal)]"
          >
            {open ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
            ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="site-mobile-menu border-t border-[var(--line-on-light)] bg-[var(--mist)]/95 backdrop-blur lg:hidden">
          <nav className="max-w-[1600px] mx-auto px-4 py-3 flex flex-col" aria-label="Mobile">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="border-b border-[var(--line-on-light)] py-3 text-[16px] text-[var(--asphalt)] transition-colors hover:text-[var(--monsoon-teal)]"
              >
                {link.label}
              </Link>
            ))}
            <div className="flex items-center gap-4 pt-4 pb-2">
              <Link
                href="/contact"
                onClick={() => setOpen(false)}
                className="text-[15px] text-[var(--text-secondary)] transition-colors hover:text-[var(--monsoon-teal)]"
              >
                Broker login
              </Link>
              <Link
                href="/contact"
                onClick={() => setOpen(false)}
              className="site-primary-cta inline-flex items-center rounded-full bg-[var(--signal-lime-on-mist)] px-4 py-2 text-sm font-semibold text-[var(--mist)] transition-colors"
              >
                Get started
              </Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
