import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  MessageSquare,
  Search,
  Users,
  Sparkles,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { LiveInboxPanel } from "@/components/home/LiveInboxPanel";

const features = [
  {
    id: "01",
    icon: MessageSquare,
    title: "Your groups, always on",
    description: "PropAI captures broker WhatsApp groups passively, so the market keeps flowing even when nobody is forwarding messages.",
    href: "/connections",
  },
  {
    id: "02",
    icon: Search,
    title: "Every listing, searchable",
    description: "Raw chat noise becomes structured property intelligence, resolved to real buildings, micro-markets and broker identities.",
    href: "#live-inbox",
  },
  {
    id: "03",
    icon: Sparkles,
    title: "Ask Pulse anything",
    description: "Use the same WhatsApp-native workflow to ask for context, history and follow-ups without learning a new dashboard.",
    href: "/dashboard",
  },
  {
    id: "04",
    icon: Users,
    title: "Private by default, networked by choice",
    description: "Your groups stay yours. Opt in to share anonymous listing data and get a wider market view in return. No raw messages are ever shared.",
    href: "#features",
  },
];

function BrandLockup() {
  return (
    <Link href="/" className="flex items-center gap-4 pl-1">
      <Image src="/propai-logo.svg" alt="PropAI" width={48} height={48} className="h-12 w-12" priority />
      <div>
        <div className="text-[17px] font-bold tracking-tight text-white leading-none">PropAI</div>
        <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-400">Broker OS</div>
      </div>
    </Link>
  );
}

function FeatureCard({
  id,
  icon: Icon,
  title,
  description,
  href,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <article className="min-h-[180px] border-t border-white/10 p-4 sm:p-5 lg:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.35em] text-[#3EE88A]">{id}</div>
        <Icon className="h-5 w-5 text-zinc-500" strokeWidth={1.7} />
      </div>
      <h3 className="mt-4 max-w-sm text-xl font-semibold tracking-tight text-white sm:text-[22px]">{title}</h3>
      <p className="mt-3 max-w-md text-sm leading-6 text-zinc-400">{description}</p>
      <Link
        href={href}
        className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[#3EE88A] transition-colors hover:text-[#74f0a5]"
      >
        Learn more
        <ChevronRight className="h-4 w-4" strokeWidth={2} />
      </Link>
    </article>
  );
}

export default function HomePage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[1400px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
          <BrandLockup />

          <nav className="flex items-center gap-3 sm:gap-5">
            <Link href="#features" className="text-sm text-zinc-400 transition-colors hover:text-white">
              Docs
            </Link>
            <Link href="#features" className="text-sm text-zinc-400 transition-colors hover:text-white">
              Pricing
            </Link>
            <Link href="/dashboard" className="text-sm text-zinc-400 transition-colors hover:text-white">
              Log in
            </Link>
            <Link
              href="/connections"
              className="inline-flex items-center gap-2 rounded-full bg-[#3EE88A] px-4 py-2 text-sm font-semibold text-black transition-transform hover:translate-y-[-1px]"
            >
              Connect WhatsApp
              <ArrowRight className="h-4 w-4" strokeWidth={2} />
            </Link>
          </nav>
        </header>

        <section className="grid flex-1 gap-12 py-8 lg:grid-cols-[9fr_11fr] lg:items-center lg:py-14">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#3EE88A]/20 bg-[#3EE88A]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#3EE88A]">
              As real as it gets · WhatsApp-native for Mumbai brokers
            </div>

            <h1 className="mt-6 max-w-xl text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">
              Your WhatsApp groups, finally organised
            </h1>

            <p className="mt-5 max-w-xl text-base leading-7 text-zinc-400 sm:text-lg">
              PropAI turns the broker conversations already happening in WhatsApp into a searchable, structured market inbox.
            </p>

            <div className="mt-6 flex flex-col gap-2">
              <div className="flex items-start gap-3 rounded-xl border border-[#3EE88A]/10 bg-[#3EE88A]/[0.03] px-4 py-3">
                <div className="mt-0.5 text-sm">🔒</div>
                <div>
                  <div className="text-sm font-semibold text-white">Private Mode <span className="text-[10px] font-normal uppercase tracking-wider text-[#3EE88A]">Default</span></div>
                  <div className="text-xs text-zinc-400 mt-1">Only your groups. Nothing shared. Immediate value.</div>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                <div className="mt-0.5 text-sm">🌐</div>
                <div>
                  <div className="text-sm font-semibold text-white">Shared Market <span className="text-[10px] font-normal uppercase tracking-wider text-zinc-500">Opt-in</span></div>
                  <div className="text-xs text-zinc-400 mt-1">Contribute to a shared market. Get visibility beyond your own network.</div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/connections"
                className="inline-flex items-center justify-center gap-2 rounded-full bg-[#3EE88A] px-5 py-3.5 text-sm font-semibold text-black transition-transform hover:translate-y-[-1px]"
              >
                Connect WhatsApp
                <ArrowRight className="h-4 w-4" strokeWidth={2} />
              </Link>
              <Link
                href="#features"
                className="inline-flex items-center justify-center rounded-full px-1 py-3 text-sm font-semibold text-zinc-400 transition-colors hover:text-white"
              >
                See how it works
              </Link>
            </div>

            <div className="mt-3 text-[11px] uppercase tracking-[0.24em] text-zinc-600">
              No credit card required · Plans from ₹599/mo · Works with the groups you are already in
            </div>
          </div>

          <div className="lg:justify-self-end">
            <LiveInboxPanel />
          </div>
        </section>

        <section id="features" className="pb-8">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-zinc-500">What you get</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                Four pieces that make the inbox useful
              </h2>
            </div>
          </div>

          <div className="grid border-l border-r border-white/5 md:grid-cols-2">
            {features.map((feature) => (
              <FeatureCard key={feature.id} {...feature} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
