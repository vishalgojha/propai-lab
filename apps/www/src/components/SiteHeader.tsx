"use client";

import Link from "next/link";
import { useState } from "react";

const NAV_LINKS = [
  { href: "/search", label: "Search" },
  { href: "/localities", label: "Localities" },
  { href: "/buildings", label: "Buildings" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-10 w-10 place-items-center rounded-[12px] bg-[#090d12] ring-1 ring-white/10"
      >
        <svg viewBox="0 0 64 64" className="h-6 w-6" fill="none" aria-hidden="true">
          <path d="M37 6L18 35h13L27 58l19-29H33L37 6Z" fill="#3EE88A" />
        </svg>
      </span>
      <span className="text-2xl font-bold tracking-tight text-white">
        Prop<span className="text-[#3EE88A]">AI</span>
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
    <header className="border-b border-white/[0.06] sticky top-0 bg-black/80 backdrop-blur z-50">
      <div className="max-w-[1600px] mx-auto px-4 lg:px-6 h-20 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="PropAI home" className="flex items-center" onClick={() => setOpen(false)}>
            <Wordmark />
          </Link>
          {backHref && (
            <Link
              href={backHref}
              className="hidden sm:inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white transition-colors"
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
              className="text-[15px] text-zinc-400 hover:text-white transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden lg:flex items-center gap-4">
          <Link
            href="https://app.propai.live/auth/login"
            className="text-[15px] text-zinc-400 hover:text-white transition-colors"
          >
            Broker login
          </Link>
          <Link
            href="https://app.propai.live/auth/signup"
            className="inline-flex items-center rounded-full bg-[#3EE88A] px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-[#2ed87a]"
          >
            Get started
          </Link>
        </div>

        {/* Mobile menu toggle */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          className="lg:hidden inline-flex items-center justify-center h-10 w-10 rounded-lg border border-white/10 text-zinc-300 hover:text-white hover:border-white/20 transition-colors"
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

      {/* Mobile dropdown */}
      {open && (
        <div className="lg:hidden border-t border-white/[0.06] bg-black/95 backdrop-blur">
          <nav className="max-w-[1600px] mx-auto px-4 py-3 flex flex-col" aria-label="Mobile">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="py-3 text-[16px] text-zinc-300 hover:text-white border-b border-white/[0.04] transition-colors"
              >
                {link.label}
              </Link>
            ))}
            <div className="flex items-center gap-4 pt-4 pb-2">
              <Link
                href="https://app.propai.live/auth/login"
                onClick={() => setOpen(false)}
                className="text-[15px] text-zinc-400 hover:text-white transition-colors"
              >
                Broker login
              </Link>
              <Link
                href="https://app.propai.live/auth/signup"
                onClick={() => setOpen(false)}
                className="inline-flex items-center rounded-full bg-[#3EE88A] px-4 py-2 text-sm font-semibold text-black transition-colors"
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
