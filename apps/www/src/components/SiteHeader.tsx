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
    <header className="site-header sticky top-0 z-50">
      <div className="site-header-inner">
        <div className="site-header-brand">
          <Link href="/" aria-label="PropAI home" className="site-wordmark" onClick={() => setOpen(false)}>
            <Wordmark />
          </Link>
          {backHref && (
            <Link
              href={backHref}
              className="site-back-link hidden sm:inline-flex"
            >
              <span aria-hidden="true">←</span> {backLabel ?? "Back"}
            </Link>
          )}
        </div>

        <nav className="site-nav hidden lg:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="site-nav-link"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="site-header-actions hidden lg:flex">
          <Link
            href="/contact"
            className="site-login-link"
          >
            Broker login
          </Link>
          <Link
            href="/contact"
            className="site-primary-cta"
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
            className="site-menu-button"
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
        <div className="site-mobile-menu lg:hidden">
          <nav className="site-mobile-nav" aria-label="Mobile">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="site-mobile-link"
              >
                {link.label}
              </Link>
            ))}
            <div className="site-mobile-actions">
              <Link
                href="/contact"
                onClick={() => setOpen(false)}
                className="site-login-link"
              >
                Broker login
              </Link>
              <Link
                href="/contact"
                onClick={() => setOpen(false)}
              className="site-primary-cta"
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
