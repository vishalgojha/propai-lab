import Link from "next/link";

const NAV_LINKS = [
  { href: "/localities", label: "Localities" },
  { href: "/buildings", label: "Buildings" },
  { href: "/about", label: "About" },
];

function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="grid h-7 w-7 place-items-center rounded-[10px] bg-[#090d12] ring-1 ring-white/10"
      >
        <svg viewBox="0 0 64 64" className="h-4 w-4" fill="none" aria-hidden="true">
          <path d="M37 6L18 35h13L27 58l19-29H33L37 6Z" fill="#3EE88A" />
        </svg>
      </span>
      <span className="text-lg font-bold tracking-tight text-white">
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
  return (
    <header className="border-b border-white/[0.06] sticky top-0 bg-black/80 backdrop-blur z-50">
      <div className="max-w-7xl mx-auto px-4 lg:px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" aria-label="PropAI home" className="flex items-center">
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
      </div>
    </header>
  );
}
