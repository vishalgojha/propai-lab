import Link from "next/link";
import { ArrowRight, Bot, KeyRound, MessageSquare, Plug, Search, ShieldCheck } from "lucide-react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { NoPhotosFaqJsonLd } from "@/components/NoPhotosFaq";

const CLIENT_INSTINCT_MESSAGE =
  "I am a PropAI buyer or tenant, not a broker. Use PropAI's public REST API. First read https://api.propai.live/api/public/v1/docs, then search only the public shared-market listings. Never ask me for broker credentials, private WhatsApp data, source phone numbers, or workspace access. Open the public listing URL when I want to contact a broker.";

export const metadata = {
  title: "PropAI — Live Mumbai broker inventory in your AI assistant",
  description:
    "Connect Instinct or any MCP client to PropAI's public Mumbai property listings. No account needed: your assistant searches the shared-market inventory brokers publish, read-only, and you continue with the broker on WhatsApp.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "PropAI — Live Mumbai broker inventory in your AI assistant",
    description:
      "Account-free, read-only access to PropAI's public Mumbai listings from your own AI assistant via Instinct or MCP.",
    type: "website",
  },
  robots: { index: false, follow: false },
};

const capabilities = [
  {
    Icon: Search,
    title: "Search the live public market",
    body: "Ask in plain English or filter by locality, BHK, budget, furnishing and rent or sale. Answers come from listings brokers publish to the shared market, not stale portal uploads.",
  },
  {
    Icon: ShieldCheck,
    title: "See freshness, not guesses",
    body: "Every listing carries first-seen and last-seen timestamps and leaves public search after 30 quiet days. Your assistant can say how fresh a place actually is.",
  },
  {
    Icon: MessageSquare,
    title: "Continue with the broker on WhatsApp",
    body: "Your assistant hands you the listing link. The WhatsApp button on that page opens a direct WhatsApp chat with the broker who shared it.",
  },
];

export default function WWWPage() {
  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <NoPhotosFaqJsonLd />
      <main id="main-content">
        <section className="home-hero mp-container px-4 lg:px-6 pt-12 lg:pt-20 pb-10 max-w-5xl mx-auto">
          <div className="home-hero-grid">
            <div>
              <p className="mp-eyebrow"><span /> Live listings from Mumbai&apos;s broker networks</p>
              <h1 className="text-[34px] lg:text-[54px] leading-[1.05] font-bold max-w-3xl">
                Search Mumbai&apos;s live broker inventory through your own <em className="text-green-400 not-italic">AI assistant</em>.
              </h1>
              <p className="mt-5 max-w-2xl text-[15px] lg:text-[17px] text-zinc-400 leading-relaxed">
                PropAI keeps a live inventory of the listings Mumbai brokers publish to their shared
                market. Ask for a place naturally, see how fresh it is, then continue with the broker.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#connect" className="site-primary-cta">
                  Connect your assistant <ArrowRight className="inline h-4 w-4" aria-hidden="true" />
                </a>
                <Link href="/search" className="site-login-link">
                  Browse listings on the site instead
                </Link>
              </div>
            </div>
            <div className="home-signal-panel" aria-label="How PropAI works">
              <div className="home-signal-topline"><span /> PUBLIC MARKET / READ-ONLY</div>
              <div className="home-signal-line"><Search aria-hidden="true" /><span>Ask for a 2 BHK in Bandra</span></div>
              <div className="home-signal-line"><ShieldCheck aria-hidden="true" /><span>See source-backed freshness</span></div>
              <div className="home-signal-line"><MessageSquare aria-hidden="true" /><span>Message the broker on WhatsApp</span></div>
              <div className="home-signal-footer">No broker workspace access. No credentials to copy.</div>
            </div>
          </div>
        </section>

        <section id="connect" className="mp-container px-4 lg:px-6 py-10 max-w-5xl mx-auto scroll-mt-24">
          <h2 className="text-2xl lg:text-3xl font-semibold">Two ways to connect</h2>
          <p className="mt-2 text-sm lg:text-[15px] text-zinc-400 max-w-2xl">
            Both are account-free and read-only. Your assistant only ever sees the public shared market - never a broker&apos;s private workspace.
          </p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
              <div className="flex items-center gap-3">
                <span className="rounded-xl border border-green-400/25 bg-green-400/10 p-3 text-green-300"><Bot className="h-5 w-5" aria-hidden="true" /></span>
                <h3 className="text-lg font-semibold">Instinct</h3>
              </div>
              <ol className="mt-4 space-y-3 text-sm text-zinc-400 leading-relaxed list-none">
                <li><strong className="text-white">1.</strong> Tell your Instinct: <em className="text-zinc-200 not-italic">&ldquo;Connect me to PropAI.&rdquo;</em></li>
                <li><strong className="text-white">2.</strong> It reads PropAI&apos;s public API guide and can search immediately - no key to copy, nothing to paste.</li>
              </ol>
              <p className="mt-4 text-xs text-zinc-500">API guide for agents:</p>
              <p className="mt-1.5 rounded-lg border border-white/10 bg-black/40 px-3 py-2">
                <code className="block font-mono text-xs sm:text-sm text-green-300 break-all select-all">https://api.propai.live/api/public/v1/docs</code>
              </p>
              <a
                href={`https://wa.me/16508702892?text=${encodeURIComponent(CLIENT_INSTINCT_MESSAGE)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-5 inline-flex items-center rounded-lg bg-green-400 px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-green-300"
              >
                Open Instinct in WhatsApp <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </a>
            </div>
            <div className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
              <div className="flex items-center gap-3">
                <span className="rounded-xl border border-green-400/25 bg-green-400/10 p-3 text-green-300"><Plug className="h-5 w-5" aria-hidden="true" /></span>
                <h3 className="text-lg font-semibold">Any MCP client</h3>
              </div>
              <ol className="mt-4 space-y-3 text-sm text-zinc-400 leading-relaxed list-none">
                <li><strong className="text-white">1.</strong> In Claude, ChatGPT or another MCP-compatible assistant, add a connector with this URL:</li>
              </ol>
              <p className="mt-3 rounded-lg border border-white/10 bg-black/40 px-3 py-2">
                <code className="block font-mono text-xs sm:text-sm text-green-300 break-all select-all">https://mcp.propai.live/mcp</code>
              </p>
              <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                <strong className="text-white">2.</strong> No sign-in step. Your assistant gets public <code>search</code> and <code>fetch</code> tools over the live market.
              </p>
            </div>
          </div>
        </section>

        <section className="mp-container px-4 lg:px-6 py-10 max-w-5xl mx-auto">
          <h2 className="text-2xl lg:text-3xl font-semibold">What your assistant can do</h2>
          <div className="mt-6 grid gap-5 md:grid-cols-3">
            {capabilities.map(({ Icon, title, body }) => (
              <div key={title} className="rounded-2xl border border-white/10 bg-zinc-950/60 p-5">
                <Icon className="h-5 w-5 text-green-300" aria-hidden="true" />
                <h3 className="mt-3 text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mp-container px-4 lg:px-6 py-10 max-w-5xl mx-auto">
          <div className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3">
              <KeyRound className="h-5 w-5 text-green-300 mt-0.5" aria-hidden="true" />
              <div>
                <h2 className="text-lg font-semibold">Are you a broker?</h2>
                <p className="mt-1 text-sm text-zinc-400 leading-relaxed">
                  The broker workspace - your own groups, clients, CRM and private inventory - lives at app.propai.live.
                </p>
              </div>
            </div>
            <a href="https://app.propai.live/auth/login" className="site-login-link whitespace-nowrap">
              Broker login <ArrowRight className="inline h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
