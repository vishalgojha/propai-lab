// The homepage aggregates live WhatsApp inventory (locality/building/listing/
// broker counts + recent activity) that updates gradually. A few minutes of
// staleness is fine and avoids re-scanning the DB on every request (and any
// CDN/proxy caching). ISR re-renders every 5 minutes, so the public counters
// stay dynamic without re-querying on each visit.
export const revalidate = 300;
// The homepage reads live Supabase data. Keep it out of Docker image build
// time; ISR/SSR should populate it when the running service has its runtime
// database credentials and network access.
export const dynamic = "force-dynamic";

import { ArrowRight, Check, ClipboardList, MessageSquare, Network, Phone, Search, Shield, Sparkles, Users, Zap } from "lucide-react";
import Link from "next/link";
import LiveListingTicker from "@/components/LiveListingTicker";
import SiteHeader from "@/components/SiteHeader";
import { NoPhotosFaqJsonLd } from "@/components/NoPhotosFaq";
import SiteFooter from "@/components/SiteFooter";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ShortlistBar from "@/components/ShortlistBar";
import { buildListingSlug, formatBhkNumber } from "@/lib/listing-card";
import { formatPublicPrice, getPublicDataOverview, type PublicDataOverview } from "@/lib/public-data";
import CountUp from "@/components/CountUp";
import ScrollReveal from "@/components/ScrollReveal";

const howItWorksSteps = [
  {
    number: "01",
    title: "Capture",
    description: "PropAI processes eligible messages from your connected WhatsApp sources.",
  },
  {
    number: "02",
    title: "Understand",
    description: "Listings, requirements, buildings, localities, prices, and broker information are structured automatically.",
  },
  {
    number: "03",
    title: "Search",
    description: "Ask for what you need in plain language and search across the market you already have.",
  },
  {
    number: "04",
    title: "Discover",
    description: "Surface relevant inventory and requirements you may never have encountered yourself.",
  },
  {
    number: "05",
    title: "Act",
    description: "Open the source context and go directly to the broker who shared it.",
  },
];

const brokerCapabilities = [
  {
    icon: Network,
    title: "Market Inbox",
    description: "A live operating view of fresh listings, requirements, broker activity, source messages, and market context.",
  },
  {
    icon: Search,
    title: "Search & Match",
    description: "Search by locality, building, BHK, budget, transaction type, property type, area, furnishing, freshness, or broker.",
  },
  {
    icon: Users,
    title: "Broker Network",
    description: "Understand who is active where, what they share, and how to reach them directly on WhatsApp.",
  },
  {
    icon: ClipboardList,
    title: "Clients & Deals",
    description: "Track requirements, saved candidates, client context, deal status, and follow-ups in one workspace.",
  },
  {
    icon: Sparkles,
    title: "Realtor Ads Studio",
    description: "Turn verified property information into marketing content without inventing missing details.",
  },
  {
    icon: Zap,
    title: "Workspace Intelligence",
    description: "See what is moving across your market and where your team is spending time, backed by live activity.",
  },
];

function withHomepageTimeout<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Homepage data query timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export default async function WWWPage() {
  // The landing page must remain available even when Supabase is temporarily
  // unreachable. Live values are rendered when the query succeeds; an empty
  // overview gives the page an honest, crawlable empty state when it does not.
  let overview: PublicDataOverview;
  const overviewPromise = Promise.resolve().then(() =>
    getPublicDataOverview({ skipBuildingScan: true, skipCounts: true, skipLocalities: true, skipActivity: true }),
  );
  const overviewResult = await Promise.allSettled([
    withHomepageTimeout(overviewPromise),
  ]).then(([result]) => result);
  if (overviewResult.status === "fulfilled") overview = overviewResult.value;
  else {
    console.error("Homepage overview query failed:", overviewResult.reason);
    overview = {
      counts: {
        localities: 0,
        buildings: 0,
        listings: 0,
        activeListings: 0,
        brokers: 0,
        raw_messages: 0,
        messagesAnalysed: 0,
      },
      countsAvailable: false,
      activity: [],
      topLocalities: [],
      topBuildings: [],
      recentListings: [],
    };
  }
  const trustStats = [
    ["Active listings", overview.counts.activeListings],
    ["Active brokers", overview.counts.brokers],
    ["Localities covered", overview.counts.localities],
    ["Messages analysed", overview.counts.messagesAnalysed],
  ] as const;
  const glanceStats = [
    ["Localities", overview.counts.localities],
    ["Buildings", overview.counts.buildings],
    ["Active listings", overview.counts.activeListings],
    ["Total listings", overview.counts.listings],
    ["Brokers", overview.counts.brokers],
    ["Messages analysed", overview.counts.messagesAnalysed],
  ] as const;

  return (
    <div className="www-shell min-h-screen">
      <SiteHeader />
      <NoPhotosFaqJsonLd />

      <main id="main-content">
       <ShortlistProvider>
        <section className="www-hero relative overflow-hidden">
          <div className="www-hero-glow" aria-hidden="true" />
          <div className="max-w-[1240px] mx-auto px-4 lg:px-8 relative">
            <div className="www-hero-grid">
              <div className="www-hero-copy">
                <div className="www-eyebrow"><span aria-hidden="true" /> Broker OS · powered by your WhatsApp market</div>
                <h1 className="text-[36px] lg:text-[68px] leading-[1.02] font-semibold tracking-[-0.045em] text-white">
                  Your market is already in WhatsApp. <span className="www-gradient-text">PropAI makes it searchable.</span>
                </h1>
                <p className="mt-6 text-[17px] lg:text-[19px] leading-8 text-zinc-400 max-w-xl">
                  Turn buried listings, requirements, and broker conversations into a live workspace for finding, matching, and moving property business.
                </p>
                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <Link href="/contact" className="www-hero-cta">Start using PropAI <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
                  <a href="#how-it-works" className="www-hero-secondary">See how it works <span aria-hidden="true">↓</span></a>
                </div>
                <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs font-medium text-[var(--site-text-muted)]">
                  <span className="inline-flex items-center gap-2"><Check className="h-3.5 w-3.5 text-[var(--accent-forest)]" /> Real WhatsApp conversations</span>
                  <span className="inline-flex items-center gap-2"><Check className="h-3.5 w-3.5 text-[var(--accent-forest)]" /> ₹1,499/month</span>
                </div>
              </div>

              <aside className="www-market-board" aria-label="How PropAI organises a broker market">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <span className="www-panel-label">THE BROKER WORKFLOW</span>
                    <h2 className="mt-2 text-xl font-semibold">From noise to next move</h2>
                  </div>
                  <span className="www-live-dot"><span aria-hidden="true" /> Live</span>
                </div>
                <div className="www-market-board-rule" />
                <div className="www-workflow-board">
                  <div className="www-workflow-row"><span className="www-workflow-icon"><MessageSquare className="h-4 w-4" /></span><span><b>WhatsApp groups</b><small>Listings · requirements · signals</small></span></div>
                  <div className="www-workflow-connector" aria-hidden="true" />
                  <div className="www-workflow-row www-workflow-row-active"><span className="www-workflow-icon"><Sparkles className="h-4 w-4" /></span><span><b>PropAI market memory</b><small>Structured · searchable · fresh</small></span></div>
                  <div className="www-workflow-connector" aria-hidden="true" />
                  <div className="www-workflow-row"><span className="www-workflow-icon"><ArrowRight className="h-4 w-4" /></span><span><b>Your next move</b><small>Find · match · contact · close</small></span></div>
                </div>
                <Link href="/contact" className="www-market-board-link">Build your market workspace <span aria-hidden="true">→</span></Link>
              </aside>
            </div>

            <LiveListingTicker />

            <div className="www-feature-grid" aria-label="PropAI broker benefits">
              {[
                {
                  icon: MessageSquare,
                  title: "The market you already have",
                  description: "Make relevant listings and requirements visible beyond the conversations where they first appeared.",
                },
                {
                  icon: Shield,
                  title: "Freshness with context",
                  description: "See what is current, where it came from, and when it was last seen before you act.",
                },
                {
                  icon: Phone,
                  title: "Action stays direct",
                  description: "Open the source context and go straight to the broker who shared the opportunity.",
                },
              ].map((item, i) => (
                <div
                  key={i}
                  className="www-feature-card transition-all duration-base hover:border-green-400/30 hover:-translate-y-0.5"
                  data-scroll-reveal
                  style={{ transitionDelay: `${i * 100}ms` } as React.CSSProperties}
                >
                  <item.icon className="w-6 h-6 text-green-400 mb-4" aria-hidden="true" />
                  <h3 className="text-lg font-semibold text-white mb-2">{item.title}</h3>
                  <p className="text-[15px] text-zinc-400">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="py-14 lg:py-20 border-b border-white/5">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="mx-auto mb-10 max-w-3xl text-center">
              <p className="www-section-kicker">THE MARKET IS BIGGER THAN YOUR GROUPS</p>
              <h2 className="mt-3 text-[28px] font-semibold tracking-[-0.03em] text-white lg:text-[40px]">Every broker only sees the conversations they&apos;re part of.</h2>
              <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-7 text-zinc-400">PropAI makes your connected WhatsApp market accessible in one workspace, so the right listing or requirement can surface before it gets lost in the scroll.</p>
            </div>
            {overview.countsAvailable && trustStats.some(([, value]) => value > 0) && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 lg:gap-8 max-w-4xl mx-auto">
                {trustStats.filter(([, value]) => value > 0).map(([label, value]) => (
                  <TrustStat key={label} label={label} value={value} />
                ))}
              </div>
            )}
            {!overview.countsAvailable && !trustStats.some(([, value]) => value > 0) && (
              <p className="text-center text-sm text-zinc-500">
                Browse current properties and contact the broker directly on WhatsApp.
              </p>
            )}
          </div>
        </section>

        <section id="live-data" className="py-16 lg:py-24 bg-zinc-950/60 border-y border-white/5" data-scroll-reveal>
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-10 lg:mb-12" data-scroll-reveal>
              <p className="www-section-kicker">LIVE MARKET PROOF</p>
              <h2 className="mt-3 text-[20px] lg:text-[24px] font-semibold text-white mb-4">A working market, not a static database</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                These live signals come from active broker conversations. The same market memory powers your inbox, search, matching, and client follow-up.
              </p>
            </div>

            {overview.countsAvailable && glanceStats.some(([, value]) => value > 0) && (
              <div className="www-stats-strip grid grid-cols-2 lg:grid-cols-6 gap-3 lg:gap-4 mb-6">
                {glanceStats.filter(([, value]) => value > 0).map(([label, value]) => (
                  <div key={label as string} className="rounded-2xl border border-white/10 bg-black/70 p-4" data-scroll-reveal>
                    <div className="text-3xl font-bold text-white">
                      <CountUp end={value as number} duration={1800} locale="en-IN" />
                    </div>
                    <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label as string}</div>
                  </div>
                ))}
              </div>
            )}

            {overview.topLocalities.length > 0 && <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
              <div className="rounded-3xl border border-white/10 bg-black/70 p-5 lg:p-6">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-white">Top localities</h3>
                    <p className="text-sm text-zinc-500">By live listing count</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {overview.topLocalities.slice(0, 4).map((loc) => (
                    <Link
                      key={loc.slug}
                      href={`/localities/${loc.slug}`}
                      className="rounded-2xl border border-white/10 bg-zinc-950/80 p-4 hover:border-green-400/30 hover:bg-zinc-900 transition-colors"
                    >
                      <div className="text-white font-medium">{loc.locality}</div>
                      <div className="mt-1 text-sm text-zinc-500">{loc.listingCount} active listing{loc.listingCount === 1 ? "" : "s"}</div>
                    </Link>
                  ))}
                </div>
              </div>

            </div>}

            {overview.recentListings.length > 0 && (
              <div className="www-listing-section mt-6 rounded-3xl border border-white/10 bg-black/70 p-5 lg:p-6">
                <div className="mb-4 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">Latest 6 listings</h3>
                    <p className="text-sm text-zinc-500">Fresh inventory from the live WhatsApp feed</p>
                  </div>
                </div>
                <div className="www-listing-list">
                  {overview.recentListings.slice(0, 6).map((row) => {
                    const textValue = (value: unknown) => typeof value === "string" ? value.trim() : "";
                    const sourceTitle = row.source_text?.split(/\r?\n/).map((line) => line.replace(/[*_]/g, "").trim()).find(Boolean);
                    const title = [row.building_name, row.landmark_name, row.summary_title, sourceTitle, row.location_label, row.micro_market]
                      .map(textValue)
                      .find(Boolean) || "Listing";
                    const slug = buildListingSlug({
                      id: row.id,
                      bhk: row.bhk,
                      micro_market: row.micro_market,
                      building_name: row.building_name,
                      property_type: row.property_type,
                    }) ?? String(row.id);
                    const price = formatPublicPrice(row.price, row.price_unit);
                    const furnishing = textValue(row.furnishing).replace(/[_-]+/g, " ");
                    const spec = [row.bhk ? formatBhkNumber(row.bhk) : "", furnishing].filter(Boolean).join(" · ");
                    const lastSeen = row.last_seen ? new Date(row.last_seen) : null;
                    const updatedLabel = lastSeen && !Number.isNaN(lastSeen.getTime())
                      ? `Updated ${lastSeen.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                      : "Updated recently";
                    return (
                      <Link
                        key={`${row.card_type ?? "listing"}-${row.id}`}
                        href={`/listings/${slug}/${row.id}`}
                        className="www-listing-row transition-colors hover:border-green-400/30"
                      >
                        <div className="www-listing-primary">
                          <div className="text-sm font-medium text-white line-clamp-2">{title}</div>
                          <div className="mt-1 text-xs text-zinc-500">
                            {textValue(row.micro_market) || "Mumbai"}{textValue(row.broker_name) ? ` · ${textValue(row.broker_name)}` : ""}
                          </div>
                        </div>
                        <div className="www-listing-price text-sm font-semibold text-green-300">
                          <div>{price}</div>
                          {spec && <div className="mt-1 text-xs font-normal text-zinc-400">{spec}</div>}
                        </div>
                        <div className="www-listing-meta text-xs text-zinc-500">
                          {updatedLabel}
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        {overview.topLocalities.length > 0 && <section id="localities" className="py-16 lg:py-24 bg-zinc-950/50">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16">
              <p className="www-section-kicker">MICRO-MARKET MEMORY</p>
              <h2 className="mt-3 text-[20px] lg:text-[24px] font-semibold text-white mb-4">Know where the market is moving</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                See the localities, buildings, and broker activity emerging from your connected network — not from a generic portal feed.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
              {overview.topLocalities.length > 0 && overview.topLocalities.slice(0, 8).map((loc) => {
                const slug = loc.slug;
                const name = loc.locality;
                const listingCount = loc.listingCount;
                return (
                  <Link
                    key={slug}
                    href={`/localities/${slug}`}
                    className="group bg-zinc-900/50 border border-white/10 rounded-xl p-5 lg:p-6 transition-colors hover:border-green-400/50 hover:bg-zinc-900"
                  >
                    <div className="flex flex-col h-full">
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <h3 className="text-lg font-semibold text-white group-hover:text-green-400 transition-colors">{name}</h3>
                      </div>
                      <p className="text-xs text-zinc-500 mt-auto flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400" aria-hidden="true" />
                        {listingCount} active listing{listingCount === 1 ? "" : "s"}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>}

        <section id="how-it-works" className="py-16 lg:py-24 bg-black" data-scroll-reveal>
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16" data-scroll-reveal>
              <p className="www-section-kicker">FROM WHATSAPP NOISE TO A WORKING MARKET</p>
              <h2 className="mt-3 text-[20px] lg:text-[24px] font-semibold text-white mb-4">Your next move starts with better market memory</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                PropAI turns the conversations you already rely on into a repeatable brokerage workflow.
              </p>
            </div>

            <div className="www-steps-grid grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-6 lg:gap-8">
              {howItWorksSteps.map((step, i) => (
                <div
                  key={i}
                  className="www-step relative bg-zinc-900/50 border border-white/10 rounded-xl p-6 lg:p-8"
                  data-scroll-reveal
                  style={{ transitionDelay: `${i * 100}ms` } as React.CSSProperties}
                >
                  <span className="text-4xl font-bold text-green-400/20 mb-4 block">{step.number}</span>
                  <h3 className="text-lg font-semibold text-white mb-3">{step.title}</h3>
                  <p className="text-[15px] text-zinc-400">{step.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="capabilities" className="py-16 lg:py-24 bg-zinc-950/50" data-scroll-reveal>
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16" data-scroll-reveal>
              <p className="www-section-kicker">THE BROKER OS</p>
              <h2 className="mt-3 text-[20px] lg:text-[24px] font-semibold text-white mb-4">Everything your brokerage needs to move faster</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                The product is broad because the work is connected: discover the market, understand it, match it, and act on it.
              </p>
            </div>

            <div className="www-capability-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-px overflow-hidden rounded-3xl border border-white/10 bg-white/10">
              {brokerCapabilities.map((item, i) => (
                <div
                  key={i}
                  className="www-capability-card bg-zinc-950/70 p-6 lg:p-8 transition-colors hover:bg-green-950/10"
                  data-scroll-reveal
                  style={{ transitionDelay: `${i * 100}ms` } as React.CSSProperties}
                >
                  <item.icon className="w-6 h-6 text-green-400 mb-4" aria-hidden="true" />
                  <h3 className="text-lg font-semibold text-white mb-2">{item.title}</h3>
                  <p className="text-[15px] text-zinc-400">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="py-16 lg:py-24 bg-black" data-scroll-reveal>
          <div className="max-w-[1100px] mx-auto px-4 lg:px-6">
            <div className="grid gap-8 lg:grid-cols-[1fr_380px] lg:items-center">
              <div>
                <p className="www-section-kicker">BUILT FOR THE WORK, NOT THE REVEAL</p>
                <h2 className="mt-3 max-w-2xl text-[30px] font-semibold tracking-[-0.035em] text-white lg:text-[48px]">We don&apos;t hide the market behind credits.</h2>
                <p className="mt-5 max-w-2xl text-[15px] leading-7 text-zinc-400">PropAI isn&apos;t a reveal system. You pay for the infrastructure that does the work: continuous processing, search, intelligence, organisation, matching, market memory, and the time saved every day.</p>
              </div>
              <div className="www-price-card">
                <span className="www-panel-label">BROKER OS</span>
                <div className="mt-4 flex items-end gap-2"><span className="text-5xl font-semibold tracking-[-0.05em] text-white">₹1,499</span><span className="pb-2 text-sm text-zinc-400">/ month</span></div>
                <p className="mt-3 text-sm leading-6 text-zinc-400">One workspace for the WhatsApp market you already have.</p>
                <Link href="/contact" className="www-hero-cta mt-6 w-full">Start using PropAI <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
              </div>
            </div>
          </div>
        </section>

        <section className="www-missed-section py-16 lg:py-24" data-scroll-reveal>
          <div className="mx-auto max-w-4xl px-4 text-center lg:px-6">
            <p className="www-section-kicker">THE QUESTION TO ASK EVERY MORNING</p>
            <h2 className="mt-3 text-[36px] font-semibold tracking-[-0.045em] text-white lg:text-[64px]">What would you have missed today?</h2>
            <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-8 text-zinc-300">The property you need may already have been posted somewhere in your connected network. PropAI helps you find the market being generated by real broker conversations — before it disappears into the scroll.</p>
            <Link href="/contact" className="www-hero-cta mt-8">Make your market searchable <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
          </div>
        </section>

       <ShortlistBar />
       </ShortlistProvider>
      </main>

      <SiteFooter />
      <ScrollReveal />
    </div>
  );
}

function TrustStat({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number;
  suffix?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-6 lg:p-8 text-center" data-scroll-reveal>
      <div className="text-3xl lg:text-4xl font-bold text-white leading-none">
        <CountUp end={value} duration={1800} locale="en-IN" suffix={suffix} />
      </div>
      <div className="mt-3 text-xs lg:text-sm text-zinc-400">{label}</div>
    </div>
  );
}
