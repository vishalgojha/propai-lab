"use client";

import Link from "next/link";
import { ArrowRight, Check, ClipboardList, Network, Search, Sparkles, Users, Zap } from "lucide-react";
import BrokerSignature from "@/components/BrokerSignature";

const steps = [
  ["01", "Capture", "Every eligible message from your connected groups, as it lands."],
  ["02", "Understand", "Buildings, localities, prices, and broker context, pulled apart."],
  ["03", "Search", "Ask for what you need in plain language, across everything you have."],
  ["04", "Discover", "Matches buried in conversations you were never part of."],
  ["05", "Act", "Open the source message and go straight to the broker on WhatsApp."],
] as const;

const capabilities = [
  [Network, "Market Inbox", "Your live operating view of listings, requirements, broker activity, source messages, and freshness."],
  [Search, "Search & Match", "Search locality, building, BHK, budget, transaction type, property type, area, freshness, or broker."],
  [Users, "Broker Network", "See who is active where, what they share, and how to reach them directly."],
  [ClipboardList, "Clients & Deals", "Track requirements, saved candidates, client context, deal status, and follow-ups."],
  [Sparkles, "Realtor Ads Studio", "Turn verified property information into marketing content without inventing missing details."],
  [Zap, "Workspace Intelligence", "See what is moving across your market and where your team is spending time."],
] as const;

export default function BrokerLandingPage() {
  return (
    <main className="broker-landing min-h-screen overflow-hidden">
      <header className="broker-nav"><div className="broker-container flex h-20 items-center justify-between"><Link href="/" className="flex items-center gap-3" aria-label="PropAI home"><img src="/propai-logo.svg" alt="" aria-hidden="true" className="h-8 w-8" /><span className="text-lg font-semibold">PropAI</span></Link><nav className="hidden items-center gap-8 text-sm text-[var(--broker-grey)] md:flex"><a href="#how-it-works">How it works</a><a href="#capabilities">Capabilities</a><a href="#pricing">Pricing</a></nav><div className="flex items-center gap-5"><Link href="/auth/login" className="hidden text-sm text-[var(--broker-grey)] hover:text-[var(--broker-paper)] sm:inline">Sign in</Link><Link href="/auth/login" className="broker-button">Start using PropAI</Link></div></div></header>

      <section className="broker-hero"><div className="broker-container grid items-center gap-14 lg:grid-cols-[1fr_0.86fr] lg:gap-20"><div><p className="broker-kicker">WhatsApp market intelligence for brokers</p><h1>Your market already talks in <em>WhatsApp shorthand.</em><br />PropAI reads it.</h1><p className="broker-hero-copy">Every listing your groups forget by tomorrow, structured and searchable today — without a broker retyping a single message.</p><div className="mt-8 flex flex-wrap items-center gap-5"><Link href="/auth/login" className="broker-button broker-button-large">Start using PropAI <ArrowRight className="h-4 w-4" /></Link><a href="#how-it-works" className="broker-text-link">See how it works <span aria-hidden="true">↓</span></a></div><div className="broker-proof"><span><Check className="h-3.5 w-3.5" /> Real WhatsApp conversations</span><span><Check className="h-3.5 w-3.5" /> ₹1,499/month</span></div></div><BrokerSignature /></div></section>

      <section className="broker-section broker-divider"><div className="broker-container"><div className="mb-14 max-w-2xl"><p className="broker-kicker">From WhatsApp noise to a working market</p><h2>Five things happen to every message before it reaches you.</h2></div><div id="how-it-works" className="broker-pipeline">{steps.map(([number, title, description]) => <article key={number} className="broker-step"><div className="broker-step-number">{number}</div><h3>{title}</h3><p>{description}</p></article>)}</div></div></section>

      <section id="capabilities" className="broker-section broker-section-muted"><div className="broker-container"><div className="mb-12 max-w-2xl"><p className="broker-kicker">The Broker OS</p><h2>Everything your brokerage needs to move faster.</h2><p className="broker-section-copy">Discover the market, understand it, match it, and act on it — in one workspace.</p></div><div className="broker-capability-grid">{capabilities.map(([Icon, title, description]) => <article key={title} className="broker-capability"><Icon className="h-5 w-5 text-[var(--broker-signal)]" /><h3>{title}</h3><p>{description}</p></article>)}</div></div></section>

      <section id="pricing" className="broker-section broker-divider"><div className="broker-container grid items-center gap-12 lg:grid-cols-[1fr_350px]"><div><p className="broker-kicker">Built for the work, not the reveal</p><h2>We don&apos;t hide the market behind credits.</h2><p className="broker-section-copy">PropAI charges for the system that does the work: infrastructure, continuous processing, search, intelligence, organisation, matching, market memory, and the time saved every day.</p></div><div className="broker-price-card"><p className="broker-mono-label">BROKER OS</p><div className="broker-price">₹1,499 <span>/ month</span></div><p>One workspace for the WhatsApp market you already have.</p><Link href="/auth/login" className="broker-button broker-button-large mt-6 w-full">Start using PropAI <ArrowRight className="h-4 w-4" /></Link></div></div></section>

      <section className="broker-cta"><div className="broker-container text-center"><p className="broker-kicker">The question to ask every morning</p><h2>What would you have missed today?</h2><p>The property you need may already have been posted somewhere in your connected network. PropAI helps you find the market being generated by real broker conversations — before it disappears into the scroll.</p><Link href="/auth/login" className="broker-button broker-button-light">Make your market searchable <ArrowRight className="h-4 w-4" /></Link></div></section>

      <footer className="broker-footer"><div className="broker-container flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span>PropAI Broker OS</span><span>Your WhatsApp property network, organised for business.</span></div></footer>
    </main>
  );
}
