"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BrainCircuit,
  Check,
  CircleCheck,
  Database,
  Gauge,
  Layers3,
  LockKeyhole,
  MessagesSquare,
  Network,
  Radar,
  Sparkles,
  Workflow,
} from "lucide-react";
import BrokerAccessPanel from "@/components/BrokerAccessPanel";

const pipeline = [
  { number: "01", title: "Ingest", copy: "Your connected market channels become a live stream of signals.", icon: MessagesSquare },
  { number: "02", title: "Reason", copy: "Specialist agents resolve shorthand, context, freshness, and confidence.", icon: BrainCircuit },
  { number: "03", title: "Coordinate", copy: "The right next action is queued, routed, and kept in your control.", icon: Workflow },
] as const;

const capabilities = [
  { title: "Market memory", copy: "Every useful signal becomes searchable context instead of disappearing in a scroll.", icon: Database, tone: "violet" },
  { title: "Agent workflows", copy: "Delegate repetitive research, matching, enrichment, and follow-up without losing oversight.", icon: Sparkles, tone: "coral" },
  { title: "Evidence, not theatre", copy: "Open the source, see the confidence, and know exactly why a recommendation exists.", icon: LockKeyhole, tone: "lime" },
  { title: "Portfolio awareness", copy: "See what is moving across your network before it becomes yesterday's inventory.", icon: Radar, tone: "pink" },
] as const;

const liveEvents = [
  ["MATCH", "3 BHK · Bandra West", "98%", "violet"],
  ["VERIFY", "Owner confirmation received", "NOW", "lime"],
  ["ROUTE", "Send to client shortlist", "READY", "coral"],
] as const;

export default function BrokerLandingPage() {
  const [accessOpen, setAccessOpen] = useState(false);

  return (
    <main className="agent-landing min-h-screen overflow-hidden">
      <header className="agent-nav">
        <div className="agent-container agent-nav-inner">
          <Link href="/" className="agent-brand" aria-label="PropAI home">
            <span className="agent-logo-mark" aria-hidden="true">P<span>·</span></span>
            <span>PropAI</span>
          </Link>
          <nav className="agent-nav-links" aria-label="Primary navigation">
            <a href="#system">The system</a>
            <a href="#agents">Agents</a>
            <a href="#signal">Signal layer</a>
          </nav>
          <div className="agent-nav-actions">
            <button type="button" onClick={() => setAccessOpen(true)} className="agent-signin">Sign in</button>
            <button type="button" onClick={() => setAccessOpen(true)} className="agent-button agent-button-small">Enter the workspace <ArrowUpRight size={14} /></button>
          </div>
        </div>
      </header>

      <section className="agent-hero agent-container">
        <div className="agent-hero-copy">
          <div className="agent-eyebrow"><span className="agent-pulse" /> Autonomous market operations <span className="agent-eyebrow-slash">/</span> Mumbai · India</div>
          <h1>The market moves.<br /><span>Your agents move first.</span></h1>
          <p className="agent-lede">PropAI turns the conversations, listings, and requirements around your brokerage into a living intelligence layer—so you can spend less time scanning and more time acting.</p>
          <div className="agent-hero-actions">
            <button type="button" onClick={() => setAccessOpen(true)} className="agent-button agent-button-primary">Build your market memory <ArrowRight size={16} /></button>
            <a href="#system" className="agent-inline-link">See the system <span>↓</span></a>
          </div>
          <div className="agent-proof-row"><span><Check size={13} /> Source-backed intelligence</span><span><Check size={13} /> Human control at every step</span></div>
        </div>

        <div className="agent-hero-visual" aria-label="Live PropAI agent activity preview">
          <div className="agent-ambient agent-ambient-one" /><div className="agent-ambient agent-ambient-two" />
          <div className="agent-console">
            <div className="agent-console-bar"><div className="agent-window-dots"><i /><i /><i /></div><span className="agent-console-title"><span className="agent-status-dot" /> PropAI / live market layer</span><span className="agent-console-time">09:41:28 IST</span></div>
            <div className="agent-console-body">
              <div className="agent-console-intro"><span className="agent-mono-label">ORCHESTRATOR</span><span className="agent-console-state">4 agents active <Activity size={12} /></span></div>
              <div className="agent-core-stage">
                <div className="agent-orbit agent-orbit-one" /><div className="agent-orbit agent-orbit-two" /><div className="agent-orbit agent-orbit-three" />
                <div className="agent-node agent-node-a"><MessagesSquare size={14} /><span>messages</span></div>
                <div className="agent-node agent-node-b"><Gauge size={14} /><span>confidence</span></div>
                <div className="agent-node agent-node-c"><Network size={14} /><span>network</span></div>
                <div className="agent-core"><Sparkles size={24} /><strong>PROP</strong><small>AGENT OS</small></div>
              </div>
              <div className="agent-activity-list">
                {liveEvents.map(([label, title, meta, tone]) => <div className="agent-activity" key={title}><span className={`agent-activity-icon ${tone}`}><CircleCheck size={13} /></span><div><span className="agent-activity-label">{label}</span><strong>{title}</strong></div><span className="agent-activity-meta">{meta}</span></div>)}
              </div>
            </div>
          </div>
          <div className="agent-float-card agent-float-top"><span className="agent-float-kicker">LIVE CONTEXT</span><strong>+24 signals</strong><span>since you opened this view</span></div>
          <div className="agent-float-card agent-float-bottom"><span className="agent-float-icon"><Layers3 size={15} /></span><div><strong>One market. Many agents.</strong><span>Working in concert, not in tabs.</span></div></div>
        </div>
      </section>

      <section className="agent-signal-strip" id="signal"><div className="agent-container agent-signal-inner"><span className="agent-signal-label">Your market, in motion</span><div className="agent-signal-items"><span>capture <b>→</b></span><span>understand <b>→</b></span><span>match <b>→</b></span><span>act <b>→</b></span><span className="agent-signal-live"><i /> learn</span></div><span className="agent-signal-caption">always on / always attributable</span></div></section>

      <section className="agent-section agent-section-light" id="system"><div className="agent-container">
        <div className="agent-section-heading"><div><div className="agent-eyebrow agent-eyebrow-dark">01 <span className="agent-eyebrow-slash">/</span> The system</div><h2>Not another dashboard.<br /><em>A new operating layer.</em></h2></div><p>Most property software waits for you to enter the work. PropAI watches the work already happening, makes sense of it, and brings the next useful move to the surface.</p></div>
        <div className="agent-pipeline-grid">{pipeline.map(({ number, title, copy, icon: Icon }, index) => <article className={`agent-pipeline-card agent-pipeline-${index + 1}`} key={number}><div className="agent-card-top"><span className="agent-card-number">{number}</span><Icon size={20} /></div><h3>{title}</h3><p>{copy}</p><span className="agent-card-link">Explore layer <ArrowUpRight size={14} /></span></article>)}</div>
        <div className="agent-command-card"><div className="agent-command-mark"><span>⌘</span></div><div><span className="agent-mono-label agent-mono-dark">A QUESTION IN, A WORKFLOW OUT</span><p>“Find the strongest 2 BHK options for my Bandra client, only if the owner confirmed availability this week.”</p></div><div className="agent-command-result"><span className="agent-command-result-label">ROUTED TO</span><strong>Search · Verify · Match</strong><span>3 agents / 0 open tabs</span></div></div>
      </div></section>

      <section className="agent-section agent-section-dark" id="agents"><div className="agent-container"><div className="agent-section-heading agent-section-heading-dark"><div><div className="agent-eyebrow">02 <span className="agent-eyebrow-slash">/</span> Agent-native by design</div><h2>Quietly powerful.<br /><em>Visibly yours.</em></h2></div><p>Each agent has a job. Together, they give your brokerage the speed of automation without surrendering the judgement that makes the business human.</p></div><div className="agent-capability-grid">{capabilities.map(({ title, copy, icon: Icon, tone }) => <article className={`agent-capability-card ${tone}`} key={title}><div className="agent-capability-icon"><Icon size={18} /></div><div><h3>{title}</h3><p>{copy}</p></div><ArrowUpRight className="agent-capability-arrow" size={16} /></article>)}</div></div></section>

      <section className="agent-section agent-section-light agent-proof-section"><div className="agent-container agent-proof-layout"><div><div className="agent-eyebrow agent-eyebrow-dark">03 <span className="agent-eyebrow-slash">/</span> Built for the real work</div><h2>Every signal has<br /><em>a source.</em></h2><p className="agent-section-copy">PropAI never asks you to trust a black box. Open the original message, inspect the evidence, and decide what deserves your attention.</p><button type="button" onClick={() => setAccessOpen(true)} className="agent-button agent-button-dark">See your market clearly <ArrowRight size={16} /></button></div><div className="agent-evidence-panel"><div className="agent-evidence-header"><span><span className="agent-status-dot" /> Evidence trail</span><span>LIVE</span></div><div className="agent-evidence-line"><span className="agent-evidence-spine" /><div><span className="agent-mono-label agent-mono-dark">09:38 · WHATSAPP GROUP</span><p>“Owner confirmed. 2.25 Cr, 950 carpet, BKC. OC. 2 parking.”</p><span className="agent-evidence-tag agent-evidence-tag-lime">verified by source</span></div></div><div className="agent-evidence-line"><span className="agent-evidence-spine muted" /><div><span className="agent-mono-label agent-mono-dark">09:40 · PROP AI</span><p>Structured listing matched to <strong>3 active requirements.</strong></p><span className="agent-evidence-tag agent-evidence-tag-violet">agent reasoning available</span></div></div><div className="agent-evidence-footer"><span>source message preserved</span><ArrowUpRight size={14} /></div></div></div></section>

      <section className="agent-cta"><div className="agent-container agent-cta-inner"><div className="agent-cta-orb"><div /></div><div className="agent-eyebrow">The next move is already in your network</div><h2>Make the invisible<br /><em>impossible to miss.</em></h2><p>Bring your market into focus with a workspace that listens, reasons, and acts alongside you.</p><button type="button" onClick={() => setAccessOpen(true)} className="agent-button agent-button-cta">Enter PropAI <ArrowRight size={16} /></button></div></section>

      <footer className="agent-footer"><div className="agent-container agent-footer-inner"><Link href="/" className="agent-brand"><span className="agent-logo-mark">P<span>·</span></span><span>PropAI</span></Link><span>Autonomous market operations for modern brokerages.</span><span className="agent-footer-meta">Mumbai · India / 2026</span></div></footer>
      {accessOpen && <BrokerAccessPanel onClose={() => setAccessOpen(false)} />}
    </main>
  );
}
