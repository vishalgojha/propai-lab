"use client";

import { MapPin, ArrowRight, MessageSquare, Phone, Shield } from "lucide-react";
import Link from "next/link";

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

const footerLinks = {
  browse: [
    { label: "All localities", href: "/localities" },
    { label: "By BHK", href: "/localities?bhk=2" },
    { label: "Under 1Cr", href: "/localities?max_price=10000000" },
    { label: "Ready to move", href: "/localities?possession=ready" },
  ],
  support: [
    { label: "How it works", href: "#how-it-works" },
    { label: "Data freshness", href: "/about#freshness" },
    { label: "Privacy", href: "/privacy" },
    { label: "Contact", href: "/contact" },
  ],
  company: [
    { label: "About PropAI", href: "/about" },
    { label: "Broker network", href: "/brokers" },
    { label: "Careers", href: "/careers" },
    { label: "Press", href: "/press" },
  ],
};

export default function WWWPage() {
  return (
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-white/[0.06] sticky top-0 bg-black/80 backdrop-blur z-50">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2" aria-label="PropAI home">
            <span className="text-xl font-bold tracking-tight">PropAI</span>
          </Link>
          <nav className="hidden lg:flex items-center gap-8">
            <Link href="/localities" className="text-[15px] text-zinc-400 hover:text-white transition-colors">Localities</Link>
            <Link href="/buildings" className="text-[15px] text-zinc-400 hover:text-white transition-colors">Buildings</Link>
            <Link href="/about" className="text-[15px] text-zinc-400 hover:text-white transition-colors">About</Link>
          </nav>
          <div className="hidden lg:flex items-center gap-4">
            <Link href="https://app.propai.live/auth/login" className="text-[15px] text-zinc-400 hover:text-white transition-colors">
              Broker login
            </Link>
            <Link
              href={`https://app.propai.live/auth/signup`}
              className="px-4 py-2 bg-green-400 text-black text-sm font-semibold rounded-lg hover:bg-green-300 transition-colors min-w-[120px] text-center"
            >
              Get started
            </Link>
          </div>
        </div>
      </header>

      <main id="main-content">
        <section className="relative pt-16 lg:pt-24 pb-16 lg:pb-24 overflow-hidden">
          <div className="max-w-7xl mx-auto px-4 lg:px-6">
            <div className="text-center max-w-3xl mx-auto mb-10 lg:mb-16">
              <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-6">
                Find your home through{" "}
                <span className="text-green-400">verified brokers</span>
              </h1>
              <p className="text-lg text-zinc-400 mb-8 max-w-2xl mx-auto">
                PropAI reads WhatsApp broker groups so you get real, fresh listings — and a direct line to the broker.
              </p>
              <div className="bg-zinc-900/50 border border-white/10 rounded-xl p-4 lg:p-6 max-w-md mx-auto">
                <label htmlFor="locality-search" className="block text-sm font-medium text-zinc-400 mb-2">
                  Search or browse by locality
                </label>
                <div className="relative">
                  <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500 w-5 h-5" aria-hidden="true" />
                  <input
                    type="search"
                    id="locality-search"
                    placeholder="e.g. Bandra West, Whitefield, Gachibowli…"
                    className="w-full bg-black border border-white/10 rounded-lg pl-12 pr-4 py-3 text-white placeholder:text-zinc-500 focus:border-green-400 focus:outline-none focus:ring-1 focus:ring-green-400 text-[15px]"
                    autoComplete="off"
                  />
                  <ArrowRight className="absolute right-4 top-1/2 -translate-y-1/2 text-zinc-500 w-5 h-5" aria-hidden="true" />
                </div>
                <p className="text-xs text-zinc-500 mt-2 text-center">
                  Powered by live WhatsApp broker conversations
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6 max-w-5xl mx-auto">
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

        <section id="localities" className="py-16 lg:py-24 bg-zinc-950/50">
          <div className="max-w-7xl mx-auto px-4 lg:px-6">
            <div className="text-center mb-12 lg:mb-16">
              <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-4">Browse by locality</h2>
              <p className="text-[15px] text-zinc-400 max-w-2xl mx-auto">
                Every locality page shows live listings, price trends, and broker activity — all sourced from live WhatsApp conversations.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-6">
              {[
                { name: "Bandra West", slug: "bandra-west", bhk: "1-4 BHK", price: "80L-15Cr", groups: 47, listings: 156, updated: "2h ago" },
                { name: "Whitefield", slug: "whitefield", bhk: "2-4 BHK", price: "60L-3Cr", groups: 38, listings: 203, updated: "1h ago" },
                { name: "Gachibowli", slug: "gachibowli", bhk: "2-3 BHK", price: "70L-4Cr", groups: 29, listings: 134, updated: "30m ago" },
                { name: "Andheri East", slug: "andheri-east", bhk: "1-3 BHK", price: "50L-6Cr", groups: 41, listings: 189, updated: "45m ago" },
                { name: "Koramangala", slug: "koramangala", bhk: "2-4 BHK", price: "90L-8Cr", groups: 33, listings: 112, updated: "2h ago" },
                { name: "Powai", slug: "powai", bhk: "2-4 BHK", price: "80L-7Cr", groups: 26, listings: 98, updated: "1h ago" },
                { name: "HSR Layout", slug: "hsr-layout", bhk: "2-3 BHK", price: "70L-5Cr", groups: 24, listings: 87, updated: "3h ago" },
                { name: "Juhu", slug: "juhu", bhk: "2-5 BHK", price: "1.5Cr-25Cr", groups: 31, listings: 76, updated: "4h ago" },
              ].map((loc) => (
                <Link
                  key={loc.slug}
                  href={`/localities/${loc.slug}`}
                  className="group bg-zinc-900/50 border border-white/10 rounded-xl p-5 lg:p-6 transition-colors hover:border-green-400/50 hover:bg-zinc-900"
                >
                  <div className="flex flex-col h-full">
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <h3 className="text-lg font-semibold text-white group-hover:text-green-400 transition-colors">{loc.name}</h3>
                      <span className="text-xs text-green-400 font-medium whitespace-nowrap">{loc.updated}</span>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-3">
                      <span className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs text-zinc-400">{loc.bhk}</span>
                      <span className="px-2 py-1 bg-zinc-800 border border-white/10 rounded text-xs text-zinc-400">{loc.price}</span>
                    </div>
                    <p className="text-xs text-zinc-500 mt-auto flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400" aria-hidden="true" />
                      Seen in {loc.groups} broker groups · {loc.listings} active listings
                    </p>
                  </div>
                </Link>
              ))}
            </div>

            <div className="text-center mt-10 lg:mt-16">
              <Link
                href="/localities"
                className="inline-flex items-center gap-2 px-6 py-3 bg-green-400 text-black text-sm font-semibold rounded-lg hover:bg-green-300 transition-colors"
              >
                View all localities
                <ArrowRight className="w-4 h-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="py-16 lg:py-24 bg-black">
          <div className="max-w-7xl mx-auto px-4 lg:px-6">
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
          <div className="max-w-7xl mx-auto px-4 lg:px-6">
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
      </main>

      <footer className="border-t border-white/10 bg-black">
        <div className="max-w-7xl mx-auto px-4 lg:px-6 py-12 lg:py-16">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-8 lg:gap-12 mb-12">
            <div className="lg:col-span-1">
              <Link href="/" className="flex items-center gap-2 mb-6" aria-label="PropAI home">
                <span className="text-xl font-bold tracking-tight">PropAI</span>
              </Link>
              <p className="text-[15px] text-zinc-500 max-w-xs">
                PropAI reads WhatsApp broker groups so you get real, fresh listings — and a direct line to the broker.
              </p>
            </div>
            <nav aria-label="Browse">
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">Browse</h4>
              <ul className="space-y-3">
                {footerLinks.browse.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-[15px] text-zinc-400 hover:text-white transition-colors">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Support">
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">Support</h4>
              <ul className="space-y-3">
                {footerLinks.support.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-[15px] text-zinc-400 hover:text-white transition-colors">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Company">
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">Company</h4>
              <ul className="space-y-3">
                {footerLinks.company.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-[15px] text-zinc-400 hover:text-white transition-colors">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <div className="pt-8 border-t border-white/10">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
              <p className="text-xs text-zinc-500">
                PropAI reads WhatsApp broker groups to build structured property data. Listings are fresh, verified, and sourced directly from broker conversations.
              </p>
              <div className="flex items-center gap-6 text-xs text-zinc-500">
                <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
                <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
                <span>&copy; 2025 PropAI</span>
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}