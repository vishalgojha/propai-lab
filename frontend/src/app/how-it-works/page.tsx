import Image from "next/image";
import Link from "next/link";
import { ArrowRight, MessageSquare, Search, Database, Lock, Bell, Brain, Layers } from "lucide-react";

const steps = [
  {
    num: "01",
    icon: MessageSquare,
    title: "Connect your existing WhatsApp",
    description:
      "No new CRM. No migration. No behaviour change. PropAI connects to the WhatsApp groups you're already in — whether you're a broker, landlord, or investor. Once connected, it starts listening without disrupting your workflow.",
    detail: "Just scan a QR code from your WhatsApp Web session. The connection is encrypted and stays active as long as your phone is online.",
  },
  {
    num: "02",
    icon: Layers,
    title: "PropAI watches the groups you're already in",
    description:
      "Broker WhatsApp groups are noisy. Fragmented language, abbreviations, mixed Hindi and English, voice notes, and screenshots. PropAI understands this language natively.",
    examples: [
      "SF — Semi-furnished",
      "FF — Fully furnished",
      "SBS — Side by side transaction",
      "+1 / Plus 1 — Indirect deal via another broker",
    ],
    detail: "Messages are cleaned, de-duplicated, and structured automatically. Voice notes are transcribed. Images are analysed for property details. Nothing is lost.",
  },
  {
    num: "03",
    icon: Database,
    title: "AI extracts structured market intelligence",
    description:
      "Raw WhatsApp messages are transformed into structured property cards — listings, requirements, buildings, brokers — all extracted automatically by PropAI's extraction engine.",
    beforeAfter: true,
    detail:
      "Every message is parsed for price, BHK, location, furnishing, possession, area, broker name, and more. The extraction engine handles inconsistent formatting, mixed languages, and abbreviations across thousands of groups.",
  },
  {
    num: "04",
    icon: Search,
    title: "Everything becomes searchable",
    description:
      "Stop scrolling through thousands of messages. Search the entire market inbox in natural language.",
    queries: [
      "3 bhk bandra under 3L",
      "Need office BKC",
      "1 BHK Andheri West semi-furnished",
      "Commercial shop Kamala Mills",
    ],
    detail:
      "Search across listings, requirements, buildings, and brokers. Results are ranked by relevance and freshness. Filter by location, budget, property type, and more — all without leaving the inbox.",
  },
{
      num: "05",
      icon: Brain,
      title: "Every broker gets a unified profile — across all your groups",
      description:
        "This is PropAI's core differentiator. The same broker appears under different names, numbers, and handles across 50+ groups. PropAI extracts their entity, deduplicates them, and surfaces everything as a single DM-like profile.",
      capabilities: [
        "Broker entity extraction — one canonical profile per person, not per handle",
        "Cross-group deduplication — messages from 'Rajesh', 'Rajesh Sharma', '98xxx5432' in 12 groups become one thread",
        "Unified DM view — open a broker's profile to see every listing, requirement, building, and conversation across all groups",
        "Alias learning — PropAI continuously merges names, phones, and display names as new evidence arrives",
        "Activity timeline — listings posted, requirements shared, buildings mentioned, markets active in",
        "Deal context — which listings matched which requirements, when, and at what price",
      ],
      detail:
        "Instead of scrolling 50 groups to find what Rajesh posted, open his profile. Every message, every property, every market — unified. This is how PropAI turns group chaos into actionable broker intelligence.",
    },
{
      num: "06",
      icon: Lock,
      title: "Private by default",
      description:
        "Your groups stay yours. Nothing leaves your workspace unless you choose to share.",
      modes: [
        {
          label: "Private (Default)",
          tag: "Default",
          description: "Only your workspace can access your data. Personal chats, client conversations, phone numbers, and WhatsApp messages never leave your workspace.",
          features: [
            "Conversations",
            "Groups",
            "Listings",
            "Requirements",
            "Broker graph",
            "Knowledge graph",
          ],
          neverShared: [
            "WhatsApp messages",
            "Media",
            "Phone numbers",
            "Customer chats",
            "Direct Messages",
            "Personal chats",
            "Client conversations",
          ],
        },
        {
          label: "Shared Market",
          tag: "Opt-in",
          description: "Contribute anonymous market intelligence and get visibility beyond your own network.",
          features: [
            "Better market visibility",
            "Cross-network inventory",
            "Demand trends",
            "Price trends (anonymized)",
            "Market activity signals",
          ],
          neverShared: [
            "WhatsApp messages",
            "Media",
            "Phone numbers",
            "Customer chats",
            "Direct Messages",
            "Personal chats",
            "Client conversations",
          ],
        },
      ],
    },
  {
    num: "07",
    icon: Bell,
    title: "Search. Monitor. Discover. Respond.",
    description:
      "Your unified market inbox replaces the chaos of 50+ WhatsApp groups with one organised workspace.",
    detail:
      "Keep track of listings. Monitor broker activity. Discover off-market deals. Respond to requirements. All from one place — without leaving your existing WhatsApp workflow.",
  },
];

function HowItWorksPage() {
  return (
    <main className="min-h-screen bg-black text-white">
      {/* ─── Navigation ─── */}
      <div className="mx-auto max-w-[1400px] px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 pb-4">
          <Link href="/" className="flex items-center gap-4 pl-1">
            <Image src="/propai-logo.svg" alt="PropAI" width={48} height={48} className="h-12 w-12" priority />
            <div>
              <div className="text-[17px] font-bold tracking-tight text-white leading-none">PropAI</div>
              <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-400">Broker OS</div>
            </div>
          </Link>

          <nav className="flex items-center gap-3 sm:gap-5">
            <Link href="/how-it-works" className="text-sm text-white transition-colors hover:text-zinc-300">
              How it works
            </Link>
            <Link href="/" className="text-sm text-zinc-400 transition-colors hover:text-white">
              Docs
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
      </div>

      {/* ─── Hero ─── */}
      <section className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-16 lg:py-24">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#3EE88A]/20 bg-[#3EE88A]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-[#3EE88A]">
            Seven steps
          </div>
          <h1 className="mt-6 text-4xl font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
            How PropAI works
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-7 text-zinc-400">
            From WhatsApp chaos to structured market intelligence in seven steps. No training, no setup, no behaviour change.
          </p>
        </div>
      </section>

      {/* ─── Steps ─── */}
      <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 pb-24">
        <div className="space-y-20">
          {steps.map((step, i) => (
            <section
              key={step.num}
              id={`step-${step.num}`}
              className="scroll-mt-20"
            >
              <div className="grid gap-8 lg:grid-cols-2 lg:gap-16">
                {/* Left column — text */}
                <div className={i % 2 === 1 ? "lg:order-2" : ""}>
                  <div className="flex items-center gap-3">
                    <step.icon className="h-5 w-5 text-[#3EE88A]" strokeWidth={1.7} />
                    <span className="text-[11px] font-bold uppercase tracking-[0.35em] text-[#3EE88A]">
                      Step {step.num}
                    </span>
                  </div>
                  <h2 className="mt-4 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                    {step.title}
                  </h2>
                  <p className="mt-4 text-base leading-7 text-zinc-400">
                    {step.description}
                  </p>

                  {/* Examples (Step 2) */}
                  {step.examples && (
                    <div className="mt-6 grid grid-cols-2 gap-2">
                      {step.examples.map((ex) => (
                        <div
                          key={ex}
                          className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-xs text-zinc-400"
                        >
                          {ex}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Search queries (Step 4) */}
                  {step.queries && (
                    <div className="mt-6 space-y-2">
                      {step.queries.map((q) => (
                        <div
                          key={q}
                          className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900 px-4 py-2 text-sm text-zinc-300"
                        >
                          <Search className="h-3.5 w-3.5 text-zinc-500" strokeWidth={1.5} />
                          {q}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Capabilities list (Step 5) */}
                  {step.capabilities && (
                    <ul className="mt-6 space-y-3">
                      {step.capabilities.map((cap) => (
                        <li key={cap} className="flex items-start gap-3 text-sm text-zinc-400">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#3EE88A]" />
                          {cap}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Modes (Step 6) */}
                  {step.modes && (
                    <div className="mt-6 grid gap-4 sm:grid-cols-2">
                      {step.modes.map((mode) => (
                        <div
                          key={mode.label}
                          className="rounded-xl border border-white/5 bg-white/[0.02] p-4"
                        >
                          <div className="flex items-center gap-2">
                            <div className="text-sm">
                              {mode.label === "Private Mode" ? "🔒" : "🌐"}
                            </div>
                            <div className="text-sm font-semibold text-white">{mode.label}</div>
                            <span
                              className={`text-[9px] font-bold uppercase tracking-wider ${
                                mode.tag === "Default"
                                  ? "text-[#3EE88A]"
                                  : "text-zinc-500"
                              }`}
                            >
                              {mode.tag}
                            </span>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-zinc-400">{mode.description}</p>
                          <ul className="mt-3 space-y-1">
                            {mode.features.map((f) => (
                              <li key={f} className="flex items-start gap-2 text-[11px] text-zinc-500">
                                <span className="mt-0.5 text-[#3EE88A]">✓</span>
                                {f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Before/After (Step 3) */}
                  {step.beforeAfter && (
                    <div className="mt-6 space-y-3">
                      <div className="rounded-xl border border-white/10 bg-zinc-900 p-4">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-2">
                          Raw WhatsApp
                        </div>
                        <div className="text-sm text-zinc-300 leading-relaxed">
                          &quot;2bhk sf andheri west nr station 65k neg ALL brokers call 98765xxxxx urgent&quot;
                        </div>
                      </div>
                      <div className="flex items-center justify-center">
                        <ArrowRight className="h-5 w-5 text-[#3EE88A]" strokeWidth={2} />
                      </div>
                      <div className="rounded-xl border border-[#3EE88A]/20 bg-[#3EE88A]/[0.03] p-4">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-[#3EE88A] mb-3">
                          Structured Property Card
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                          <div><span className="text-zinc-500">Type:</span> <span className="text-white">Listing</span></div>
                          <div><span className="text-zinc-500">BHK:</span> <span className="text-white">2</span></div>
                          <div><span className="text-zinc-500">Furnishing:</span> <span className="text-white">Semi-furnished</span></div>
                          <div><span className="text-zinc-500">Location:</span> <span className="text-white">Andheri West</span></div>
                          <div><span className="text-zinc-500">Price:</span> <span className="text-white">₹65,000/mo</span></div>
                          <div><span className="text-zinc-500">Landlord:</span> <span className="text-white">Direct</span></div>
                          <div><span className="text-zinc-500">Contact:</span> <span className="text-white">98765xxxxx</span></div>
                          <div><span className="text-zinc-500">Urgency:</span> <span className="text-amber-400">Urgent</span></div>
                        </div>
                      </div>
                    </div>
                  )}

                  <p className="mt-4 text-sm leading-6 text-zinc-500">{step.detail}</p>
                </div>

                {/* Right column — visual placeholder / mockup area for future screenshots */}
                <div className={i % 2 === 1 ? "lg:order-1" : ""}>
                  <div className="sticky top-8 rounded-2xl border border-white/5 bg-white/[0.02] p-8 lg:p-12">
                    <div className="flex items-center justify-center">
                      <div className="text-center">
                        <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-white/5 bg-zinc-900">
                          <step.icon className="h-8 w-8 text-[#3EE88A]" strokeWidth={1.5} />
                        </div>
                        <div className="mt-4 text-5xl font-bold tracking-tight text-white/10">
                          {step.num}
                        </div>
                        <div className="mt-2 text-sm font-medium text-zinc-500">
                          {i === 0 && "Just scan. No setup."}
                          {i === 1 && "Broker language, understood."}
                          {i === 2 && "Chaos → Structure"}
                          {i === 3 && "Search instead of scroll"}
                          {i === 4 && "One broker. One profile. Every group."}
                          {i === 5 && "You control what leaves"}
                          {i === 6 && "One inbox to rule them all"}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Separator */}
              {i < steps.length - 1 && (
                <div className="mt-20 border-t border-white/5" />
              )}
            </section>
          ))}
        </div>
      </div>

      {/* ─── CTA ─── */}
      <section className="border-t border-white/5">
        <div className="mx-auto max-w-[1400px] px-4 py-16 sm:px-6 lg:px-8 lg:py-24">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Ready to organise your market?
            </h2>
            <p className="mt-4 text-lg text-zinc-400">
              Connect WhatsApp in under a minute. No credit card required.
            </p>
            <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              <Link
                href="/connections"
                className="inline-flex items-center gap-2 rounded-full bg-[#3EE88A] px-6 py-3.5 text-sm font-semibold text-black transition-transform hover:translate-y-[-1px]"
              >
                Connect WhatsApp
                <ArrowRight className="h-4 w-4" strokeWidth={2} />
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-sm font-semibold text-zinc-400 transition-colors hover:text-white"
              >
                Back to homepage
              </Link>
            </div>
            <div className="mt-4 text-[11px] uppercase tracking-[0.24em] text-zinc-600">
              Plans from ₹599/mo · Works with the groups you are already in
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

export default HowItWorksPage;
