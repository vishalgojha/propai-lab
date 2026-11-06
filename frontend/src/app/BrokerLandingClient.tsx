"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Check, ClipboardList, MessageCircle, Network, Search, Sparkles, Users, Zap } from "lucide-react";
import BrokerSignature from "@/components/BrokerSignature";
import BrokerAccessPanel from "@/components/BrokerAccessPanel";

const steps = [
  ["01", "Capture", "Bring your selected WhatsApp conversations into one operating inbox."],
  ["02", "Structure", "Turn messy messages into source-backed inventory and buyer requirements."],
  ["03", "Qualify", "Search your stock, leads, and requirements without retyping every message."],
  ["04", "Match", "See the best inventory options for each buyer, with the evidence attached."],
  ["05", "Close", "Move from WhatsApp message to follow-up, viewing, and deal tracking."],
] as const;

const capabilities = [
  [Network, "WhatsApp Inbox", "Your private operating view of captured messages, inventory, requirements, and freshness."],
  [Search, "Search & Match", "Search locality, building, BHK, budget, transaction type, property type, area, freshness, or broker."],
  [Users, "Leads & Clients", "Keep buyer context, requirements, conversations, and next actions together."],
  [ClipboardList, "Inventory & Deals", "Track your stock, shortlist candidates, deal status, viewings, and follow-ups."],
  [Sparkles, "Ads Studio", "Turn verified property information into marketing content without inventing missing details."],
  [Zap, "Brokerage Intelligence", "Know what needs attention today across your inventory, leads, and active deals."],
] as const;

export default function BrokerLandingClient() {
  const [accessOpen, setAccessOpen] = useState(false);
  const [accessNext, setAccessNext] = useState("/inbox");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("access") !== "signin") return;
    const next = params.get("next");
    if (next && next.startsWith("/") && !next.startsWith("//")) setAccessNext(next);
    setAccessOpen(true);
  }, []);

  return (
    <main className="broker-landing min-h-screen overflow-hidden">
      <header className="broker-nav"><div className="broker-container flex h-20 items-center justify-between"><Link href="/" className="flex items-center gap-3" aria-label="PropAI home"><img src="/propai-logo.svg" alt="" aria-hidden="true" className="h-8 w-8" /><span className="text-lg font-semibold">PropAI</span></Link><nav className="hidden items-center gap-8 text-sm text-[var(--text-secondary)] md:flex"><a href="#how-it-works">How it works</a><a href="#capabilities">Capabilities</a><a href="#pricing">Pricing</a></nav><div className="flex items-center gap-5"><button type="button" onClick={() => setAccessOpen(true)} className="hidden text-sm text-[var(--text-secondary)] hover:text-[var(--foreground)] sm:inline">Sign in</button><button type="button" onClick={() => setAccessOpen(true)} className="broker-button">Start using PropAI</button></div></div></header>

      <section className="broker-hero"><div className="broker-container grid items-center gap-14 lg:grid-cols-[1fr_0.86fr] lg:gap-20"><div><p className="broker-kicker">Your private brokerage copilot</p><h1>Connect Claude to the <em>WhatsApp market you already use.</em></h1><p className="broker-hero-copy">PropAI MCP gives Claude a tenant-scoped view of your source-backed inventory, buyer requirements, matches, and follow-ups — without exposing another brokerage&apos;s workspace.</p><div className="mt-8 flex flex-wrap items-center gap-5"><button type="button" onClick={() => setAccessOpen(true)} className="broker-button broker-button-large">Connect PropAI MCP <ArrowRight className="h-4 w-4" /></button><a href="#how-it-works" className="broker-text-link">See how it works <span aria-hidden="true">↓</span></a></div><div className="broker-proof"><span><Check className="h-3.5 w-3.5" /> Private workspace tools</span><span><Check className="h-3.5 w-3.5" /> Human approval stays on</span></div></div><BrokerSignature /></div></section>

      <section className="broker-section broker-divider"><div className="broker-container"><div className="mb-14 max-w-2xl"><p className="broker-kicker">From WhatsApp noise to a working market</p><h2>Five things happen to every message before it reaches you.</h2></div><div id="how-it-works" className="broker-pipeline">{steps.map(([number, title, description]) => <article key={number} className="broker-step"><div className="broker-step-number">{number}</div><h3>{title}</h3><p>{description}</p></article>)}</div></div></section>

      <section id="capabilities" className="broker-section broker-section-muted"><div className="broker-container"><div className="mb-12 max-w-2xl"><p className="broker-kicker">The Brokerage OS</p><h2>One private workspace for the work between message and closing.</h2><p className="broker-section-copy">Capture, qualify, match, follow up, and close — with the original WhatsApp evidence still attached.</p></div><div className="broker-capability-grid">{capabilities.map(([Icon, title, description]) => <article key={title} className="broker-capability"><Icon className="h-5 w-5 text-[var(--accent)]" /><h3>{title}</h3><p>{description}</p></article>)}</div></div></section>

      <section id="pricing" className="broker-section broker-divider"><div className="broker-container"><div className="mb-12 max-w-2xl"><p className="broker-kicker">Two ways to work with PropAI</p><h2>Start with MCP. Upgrade to your WhatsApp copilot when you&apos;re ready.</h2><p className="broker-section-copy">Both plans keep your brokerage workspace private. The higher tier adds a self-chat agent that works from your own WhatsApp conversation.</p></div><div className="broker-pricing-grid"><article className="broker-price-card"><div className="flex items-start justify-between gap-4"><div><p className="broker-mono-label">MCP ONLY</p><h3 className="mt-3 text-xl">PropAI MCP</h3></div><Network className="h-5 w-5 text-[var(--accent)]" /></div><div className="broker-price">₹799 <span>/ month</span></div><p>Connect Claude or another MCP client to your tenant-scoped PropAI workspace.</p><ul className="broker-plan-list"><li><Check className="h-4 w-4" /> Search private inventory and requirements</li><li><Check className="h-4 w-4" /> Match, summarize, and draft ads</li><li><Check className="h-4 w-4" /> No WhatsApp self-chat agent</li></ul><button type="button" onClick={() => setAccessOpen(true)} className="broker-button broker-button-large mt-6 w-full">Choose MCP <ArrowRight className="h-4 w-4" /></button></article><article className="broker-price-card broker-price-card-featured"><div className="flex items-start justify-between gap-4"><div><p className="broker-mono-label">MOST HANDS-ON</p><h3 className="mt-3 text-xl">WhatsApp Self-Chat Agent</h3></div><MessageCircle className="h-5 w-5 text-[var(--accent)]" /></div><div className="broker-price">₹1,999 <span>/ month</span></div><p>Message yourself on WhatsApp and let PropAI search, explain, remember, and act inside your private workspace.</p><ul className="broker-plan-list"><li><Check className="h-4 w-4" /> Everything in MCP</li><li><Check className="h-4 w-4" /> Self-chat agent on your connected WhatsApp</li><li><Check className="h-4 w-4" /> Natural replies, follow-ups, and broker workflows</li></ul><button type="button" onClick={() => setAccessOpen(true)} className="broker-button broker-button-large mt-6 w-full">Choose Self-Chat <ArrowRight className="h-4 w-4" /></button></article></div></div></section>

      <section className="broker-cta"><div className="broker-container text-center"><p className="broker-kicker">The question to ask every morning</p><h2>What would you have missed today?</h2><p>The property you need may already have been posted somewhere in your connected network. PropAI helps you find the market being generated by real broker conversations — before it disappears into the scroll.</p><button type="button" onClick={() => setAccessOpen(true)} className="broker-button broker-button-light">Make your market searchable <ArrowRight className="h-4 w-4" /></button></div></section>

      <footer className="broker-footer"><div className="broker-container flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span>PropAI Broker OS</span><span>Your WhatsApp property network, organised for business.</span></div></footer>
      {accessOpen && <BrokerAccessPanel nextPath={accessNext} onClose={() => setAccessOpen(false)} />}
    </main>
  );
}
