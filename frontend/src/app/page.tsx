import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  MessageSquare,
  Search,
  Users,
  ChevronRight,
  Building2,
  Brain,
  Briefcase,
  type LucideIcon,
} from "lucide-react";

const features = [
  {
    id: "01",
    icon: MessageSquare,
    title: "Market Inbox",
    description: "All your broker WhatsApp groups in one organised feed. No more scrolling through 50+ groups to find what matters.",
    href: "/inbox",
    tag: "Connected data",
  },
  {
    id: "02",
    icon: Brain,
    title: "AI Extraction Engine",
    description: "Raw WhatsApp messages are parsed into structured property data: price, BHK, location, furnishing, possession, and broker.",
    href: "/how-it-works#step-03",
    tag: "Connected data",
  },
  {
    id: "03",
    icon: Building2,
    title: "Building & Broker Memory",
    description: "PropAI builds profiles for every building and broker from real messages. Aliases, relationships, and activity patterns are learned from evidence.",
    href: "/how-it-works#step-05",
    tag: "Connected data",
  },
  {
    id: "04",
    icon: Search,
    title: "Universal Search",
    description: 'Search "3 bhk bandra under 3L" or "Need office BKC" across connected messages, listings, and requirements.',
    href: "/search",
    tag: "Connected data",
  },
  {
    id: "05",
    icon: Briefcase,
    title: "Broker Profiles",
    description: "Every broker gets a profile with their deal history, property types, active micro-markets, and network relationships.",
    href: "/brokers",
    tag: "Connected data",
  },
  {
    id: "06",
    icon: Users,
    title: "Shared Broker Network",
    description: "Shared market mode is the default. PropAI parses real-estate groups while DMs, personal chats, client groups, and opted-out groups stay out of extraction.",
    href: "/how-it-works#step-06",
    tag: "Default",
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
  tag,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
  tag: string;
}) {
  return (
    <article className="min-h-[180px] border-t border-white/10 p-4 sm:p-5 lg:p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="text-[11px] font-bold uppercase tracking-[0.35em] text-[#3EE88A]">{id}</div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-wider text-[#3EE88A]">{tag}</span>
          <Icon className="h-5 w-5 text-zinc-500" strokeWidth={1.7} />
        </div>
      </div>
      <h3 className="mt-4 max-w-sm text-xl font-semibold tracking-tight text-white sm:text-[22px]">{title}</h3>
      <p className="mt-3 max-w-md text-sm leading-6 text-zinc-400">{description}</p>
      <Link
        href={href}
        className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[#3EE88A] transition-colors hover:text-[#74f0a5]"
      >
        See it in action
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
        </header>

        <section className="flex flex-1 items-center py-8 lg:py-14">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-[#3EE88A]/20 bg-[#3EE88A]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#3EE88A]">
              WhatsApp-native · Mumbai real estate
            </div>

            <h1 className="mt-6 max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-5xl">
              All your WhatsApp groups. One organised market inbox.
            </h1>

            <p className="mt-5 max-w-3xl text-base leading-7 text-zinc-400 sm:text-lg">
              PropAI connects to your existing broker WhatsApp groups, extracts real listings and requirements, and builds searchable broker and building profiles without changing how brokers already work.
            </p>

            <div className="mt-6 flex flex-wrap gap-2">
              {["Market Inbox", "AI Extraction", "Broker Memory", "Building Intel", "Universal Search"].map((label) => (
                <span key={label} className="rounded-full border border-white/5 bg-white/[0.03] px-3 py-1.5 text-[11px] text-zinc-400">
                  {label}
                </span>
              ))}
            </div>

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link
                href="/auth/signup?next=/connections"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#3EE88A] px-5 py-3 text-sm font-semibold text-black transition-transform hover:translate-y-[-1px]"
              >
                Get started
                <ArrowRight className="h-4 w-4" strokeWidth={2} />
              </Link>
              <Link
                href="/how-it-works"
                className="inline-flex items-center justify-center rounded-lg px-5 py-3 text-sm font-semibold text-zinc-400 transition-colors hover:text-white"
              >
                How it works
              </Link>
            </div>

            <div className="mt-4 flex flex-col gap-2">
              <div className="flex items-start gap-3 rounded-xl border border-[#3EE88A]/10 bg-[#3EE88A]/[0.03] px-4 py-3">
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-[#3EE88A]" strokeWidth={1.8} />
                <div>
                  <div className="text-sm font-semibold text-white">
                    Shared Market <span className="text-[10px] font-normal uppercase tracking-wider text-[#3EE88A]">Default</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Real-estate group listings, requirements, building signals, and broker activity contribute to the broker network.
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3">
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" strokeWidth={1.8} />
                <div>
                  <div className="text-sm font-semibold text-white">Never parsed by default</div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Direct messages, personal chats, client groups, friends and family groups, and opted-out groups are excluded from extraction.
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 text-[11px] uppercase tracking-[0.24em] text-zinc-600">
              No synthetic data on public pages. Connect WhatsApp to see your real broker network.
            </div>
          </div>
        </section>

        <section id="features" className="pb-8">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.3em] text-zinc-500">What you get</div>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                Everything you need from WhatsApp, without leaving it
              </h2>
            </div>
          </div>

          <div className="grid border-l border-r border-white/5 md:grid-cols-2 lg:grid-cols-3">
            {features.map((feature) => (
              <FeatureCard key={feature.id} {...feature} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
