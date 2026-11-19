import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { getPublicDataOverview } from "@/lib/public-data";
import { getAllLocalities } from "@/lib/localities";

export const dynamic = "force-dynamic";

export const metadata = {
  robots: { index: true, follow: true },
  title: "About PropAI | Live broker inventory from WhatsApp groups",
  description:
    "PropAI turns brokers' WhatsApp posts into searchable property inventory your AI assistant can query. Public search needs no PropAI account. Posts leave public search after 30 quiet days.",
  openGraph: {
    title: "About PropAI | Live broker inventory from WhatsApp groups",
    description:
      "How PropAI turns broker WhatsApp posts into searchable property inventory you query through your own AI assistant.",
  },
};

export default async function AboutPage() {
  const known = await getAllLocalities();
  const overview = await getPublicDataOverview({ localities: known });
  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <main className="www-page-main www-content-page max-w-3xl mx-auto px-4 lg:px-6 py-10 lg:py-16">
        <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-6">
          About <span className="text-green-400">PropAI</span>
        </h1>

        <div className="space-y-8 text-[15px] lg:text-[17px] text-zinc-400 leading-relaxed">
          <p>
            PropAI turns the property posts brokers share in their WhatsApp
            groups into searchable inventory you can query through your own AI
            assistant. Searching the public inventory needs no PropAI account:
            connect Instinct or any MCP-compatible assistant and ask for a place
            in plain English. Your assistant provider&apos;s own account or
            subscription terms apply separately.
          </p>
          <div>
            <h2 className="text-lg lg:text-xl font-semibold text-white mb-3">
              Captured posts, not verified availability
            </h2>
            <p>
              Every listing is captured from a real broker&apos;s post, and the
              original message is kept as its source trail. A listing shows what
              a broker reported, not a confirmed availability check, so confirm
              the current status and details with the broker before acting on
              it. A post leaves public search after 30 days without being seen
              again.
            </p>
          </div>
          <div>
            <h2 className="text-lg lg:text-xl font-semibold text-white mb-3">
              Taking a listing forward
            </h2>
            <p>Every listing page has a WhatsApp enquiry button.</p>
          </div>
          <div>
            <h2 className="text-lg lg:text-xl font-semibold text-white mb-3">
              The workspace behind the inventory
            </h2>
            <p>
              Brokers connect their own WhatsApp groups at app.propai.live and
              search their deal flow, listings and client requirements, through
              their assistant. Broker access starts with a 15-day free trial.
            </p>
          </div>
        </div>

        <div className="mt-10 grid grid-cols-2 lg:grid-cols-4 gap-4">
          <AboutStat label="Active listings" value={overview.counts.activeListings} />
          <AboutStat label="Active brokers" value={overview.counts.brokers} />
          <AboutStat label="Localities covered" value={overview.counts.localities} />
          <AboutStat
            label="Messages analysed"
            value={overview.counts.messagesAnalysed}
          />
        </div>
        <p className="mt-4 text-sm text-zinc-500">
          These numbers are pulled live from the same broker conversations powering
          every listing on this site. They update as brokers post.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}

function AboutStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/50 p-4 text-center">
      <div className="text-2xl font-bold text-white leading-none">
        {value.toLocaleString("en-IN")}
      </div>
      <div className="mt-2 text-xs text-zinc-400">{label}</div>
    </div>
  );
}
