// The homepage aggregates live WhatsApp inventory (locality/building/listing/
// broker counts + recent activity) that updates gradually. A few minutes of
// staleness is fine and avoids re-scanning the DB on every request (and any
// CDN/proxy caching). ISR re-renders every 5 minutes, so the public counters
// stay dynamic without re-querying on each visit.
export const revalidate = 300;

import { MapPin, MessageSquare, Phone, Shield } from "lucide-react";
import Link from "next/link";
import HomeSearch from "@/components/HomeSearch";
import LiveListingTicker from "@/components/LiveListingTicker";
import SiteHeader from "@/components/SiteHeader";
import { NoPhotosFaqJsonLd } from "@/components/NoPhotosFaq";
import SiteFooter from "@/components/SiteFooter";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ShortlistBar from "@/components/ShortlistBar";
import { getAllLocalities } from "@/lib/localities";
import { getPublicDataOverview } from "@/lib/public-data";

const howItWorksSteps = [
  {
    number: "01",
    title: "Browse listings",
    description: "Explore verified properties in your locality. Every listing comes from active WhatsApp broker conversations.",
  },
  {
    number: "02",
    title: "Send an enquiry",
    description: "Tap 'Enquire' on any listing. Your details go straight to the broker on WhatsApp — no forms, no spam.",
  },
  {
    number: "03",
    title: "Broker calls you",
    description: "The broker calls you directly on your phone. You deal with a real person, not a chatbot.",
  },
];

const fallbackLocalities = [
  { name: "Bandra West", slug: "bandra-west", listingCount: 156 },
  { name: "Andheri West", slug: "andheri-west", listingCount: 189 },
  { name: "Andheri East", slug: "andheri-east", listingCount: 189 },
  { name: "Powai", slug: "powai", listingCount: 98 },
  { name: "Juhu", slug: "juhu", listingCount: 76 },
  { name: "Khar West", slug: "khar-west", listingCount: 64 },
  { name: "Malad West", slug: "malad-west", listingCount: 58 },
  { name: "Goregaon West", slug: "goregaon-west", listingCount: 51 },
];

export default async function WWWPage() {
  const known = await getAllLocalities();
  const overview = await getPublicDataOverview({ localities: known });
  const hasData = known.length > 0;

  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <NoPhotosFaqJsonLd />

      <main id="main-content">
       <ShortlistProvider>
        <section className="relative pt-16 lg:pt-24 pb-16 lg:pb-24 overflow-hidden">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center max-w-5xl mx-auto mb-10 lg:mb-16">
              <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-6">
                Find your property through{" "}
                <span className="text-green-400">verified brokers</span>
              </h1>
              <p className="text-lg text-zinc-400 mb-8 max-w-2xl mx-auto">
                PropAI reads WhatsApp broker groups so you get real, fresh residential and commercial listings — and a direct line to the broker.
              </p>
              <HomeSearch localities={known} />
              <p className="mt-6 text-center text-sm text-zinc-500">
                Try searching a locality, building, or &ldquo;2 BHK in Bandra&rdquo;.
              </p>
            </div>

            <LiveListingTicker />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 max-w-[1600px] mx-auto">
              {[
                {
                  icon: MessageSquare,
                  title: "Direct to broker",
                  description: "Your enquiry lands on the broker's WhatsApp instantly. They call you directly on your phone.",
                },
                {
                  icon: Shield,
                  title: "Freshness guaranteed",
                  description: "Listings update daily from live conversations. Stale data is auto-hidden after 30 days.",
                },
                {
                  icon: Phone,
                  title: "Real brokers, real calls",
                  description: "No chatbots. Your enquiry goes to a real broker who calls you on your phone.",
                },
              ].map((item, i) => (
                <div key={i} className="bg-zinc-900/50 border border-white/10 rounded-xl p-6 lg:p-8">
                  <item.icon className="w-6 h-6 text-green-400 mb-4" aria-hidden="true" />
                  <h3 className="text-lg font-semibold text-white mb-2">{item.title}</h3>
                  <p className="text-[15px] text-zinc-400">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="py-10 lg:py-14 border-b border-white/5">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <p className="text-center text-sm text-zinc-500 mb-6">
              Real estate intelligence, sourced from live broker activity — not portals
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6 max-w-4xl mx-auto">
              <TrustStat label="Live listings tracked" value={overview.counts.listings} />
              <TrustStat label="Brokers in network" value={overview.counts.brokers} />
              <TrustStat label="Localities covered" value={overview.counts.localities} />
              <TrustStat
                label="Daily refresh"
                value={`${overview.counts.parsed_observations.toLocaleString()}+ records`}
              />
            </div>
          </div>
        </section>

        <section id="live-data" className="py-16 lg:py-24 bg-zinc-950/60 border-y border-white/5">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-10 lg:mb-12">
              <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-4">Live data at a glance</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                Everything we&apos;ve captured so far is public on www: localities, buildings, listings, and broker activity.
              </p>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 lg:gap-4 mb-6">
              {[
                ["Localities", overview.counts.localities],
                ["Buildings", overview.counts.buildings],
                ["Listings", overview.counts.listings],
                ["Brokers", overview.counts.brokers],
                ["Raw messages", overview.counts.raw_messages],
                ["Parsed records", overview.counts.parsed_observations],
              ].map(([label, value]) => (
                <div key={label as string} className="rounded-2xl border border-white/10 bg-black/70 p-4">
                  <div className="text-3xl font-bold text-white">{(value as number).toLocaleString()}</div>
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-zinc-500">{label as string}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
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

              <div className="rounded-3xl border border-white/10 bg-black/70 p-5 lg:p-6">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-white">Top buildings</h3>
                    <p className="text-sm text-zinc-500">By live listing count</p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {overview.topBuildings.slice(0, 4).map((building) => (
                    <Link
                      key={building.name}
                      href={`/search?q=${encodeURIComponent(building.name)}`}
                      className="rounded-2xl border border-white/10 bg-zinc-950/80 p-4 hover:border-green-400/30 hover:bg-zinc-900 transition-colors"
                    >
                      <div className="text-white font-medium">{building.name}</div>
                      <div className="mt-1 text-sm text-zinc-500">{building.listingCount} listing{building.listingCount === 1 ? "" : "s"}</div>
                      <div className="mt-1 text-xs text-zinc-500">{building.microMarket || "Market pending"}</div>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="localities" className="py-16 lg:py-24 bg-zinc-950/50">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16">
              <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-4">Browse by locality</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                Every locality page shows live listings, price trends, and broker activity — all sourced from live WhatsApp conversations.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
              {(hasData ? known.slice(0, 8) : fallbackLocalities).map((loc) => {
                const slug = loc.slug;
                const name = "locality" in loc ? loc.locality : loc.name;
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
        </section>

        <section id="how-it-works" className="py-16 lg:py-24 bg-black">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16">
              <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-4">How it works</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                Three simple steps — no apps to download, no accounts to create.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
              {howItWorksSteps.map((step, i) => (
                <div key={i} className="relative bg-zinc-900/50 border border-white/10 rounded-xl p-6 lg:p-8">
                  <span className="text-4xl font-bold text-green-400/20 mb-4 block">{step.number}</span>
                  <h3 className="text-lg font-semibold text-white mb-3">{step.title}</h3>
                  <p className="text-[15px] text-zinc-400">{step.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16 lg:py-24 bg-zinc-950/50">
          <div className="max-w-[1600px] mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16">
              <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-4">Why PropAI?</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                We don't scrape portals. We read the source — live WhatsApp conversations between brokers and buyers.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
              {[
                {
                  icon: MessageSquare,
                  title: "Direct to broker",
                  description: "Your enquiry lands on the broker's WhatsApp instantly. They call you directly on your phone.",
                },
                {
                  icon: Shield,
                  title: "Freshness guaranteed",
                  description: "Listings update daily from live conversations. Stale data is auto-hidden after 30 days.",
                },
                {
                  icon: Phone,
                  title: "Real brokers, real calls",
                  description: "No chatbots. Your enquiry goes to a real broker who calls you on your phone.",
                },
              ].map((item, i) => (
                <div key={i} className="bg-zinc-900/50 border border-white/10 rounded-xl p-6 lg:p-8">
                  <item.icon className="w-6 h-6 text-green-400 mb-4" aria-hidden="true" />
                  <h3 className="text-lg font-semibold text-white mb-2">{item.title}</h3>
                  <p className="text-[15px] text-zinc-400">{item.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="no-photos" className="py-16 lg:py-24 bg-black">
          <div className="max-w-3xl mx-auto px-4 lg:px-6">
            <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-6 lg:p-8">
              <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-3">
                Why we skip photos on purpose
              </h2>
              <p className="text-[15px] text-zinc-400 leading-relaxed">
                This inventory moves fast. Message the broker directly and they&apos;ll
                send you real, current photos and videos over WhatsApp — not stock
                images from whenever the listing was first posted. Pre-loading static
                photos would misrepresent what&apos;s actually available today, so we
                keep the page fast and the media fresh, straight from the source.
              </p>
            </div>
          </div>
        </section>
       <ShortlistBar />
       </ShortlistProvider>
      </main>

      <SiteFooter />
    </div>
  );
}

function TrustStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-5 text-center">
      <div className="text-2xl lg:text-3xl font-bold text-white leading-none">
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </div>
      <div className="mt-2 text-xs text-zinc-400">{label}</div>
    </div>
  );
}
