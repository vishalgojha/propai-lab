import Link from "next/link";
import { ArrowRight, Clock3, MapPin, MessageSquare, Search, ShieldCheck, type LucideIcon } from "lucide-react";
import HomeSearch from "@/components/HomeSearch";
import LatestListingsGrid from "@/components/LatestListingsGrid";
import LiveListingTicker from "@/components/LiveListingTicker";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { NoPhotosFaqJsonLd } from "@/components/NoPhotosFaq";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ShortlistBar from "@/components/ShortlistBar";
import CountUp from "@/components/CountUp";
import { Card, CardContent } from "@/components/ui/card";
import type { PublicDataOverview } from "@/lib/public-data";
import { buildListingSlug } from "@/lib/listing-card";

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

const processSteps: Array<{ number: string; Icon: LucideIcon; title: string; body: string }> = [
  { number: "01", Icon: Search, title: "Browse live listings", body: "Explore homes and commercial spaces from active broker conversations." },
  { number: "02", Icon: ShieldCheck, title: "Send an enquiry", body: "Share your brief in one tap with the broker who shared the listing." },
  { number: "03", Icon: MessageSquare, title: "Continue on WhatsApp", body: "Ask for current photos, terms, and the next viewing directly." },
];

export default function PublicMarketplaceHome({ overview }: { overview: PublicDataOverview }) {
  const listings = overview.recentListings.slice(0, 6);
  const stats = [
    [overview.counts.activeListings, "Fresh listings", "from active broker chats"],
    [overview.counts.localities, "Localities covered", "across live markets"],
    [overview.counts.brokers, "Broker network", "real conversations only"],
    [overview.counts.messagesAnalysed, "Messages analysed", "source-grounded inventory"],
  ] as const;

  return <div className="www-shell min-h-screen">
    <SiteHeader />
    <NoPhotosFaqJsonLd />
    <main id="main-content">
      <ShortlistProvider>
        <section className="mp-hero" id="search">
          <div className="mp-container mp-hero-grid">
            <div className="mp-hero-copy">
              <p className="mp-eyebrow"><span /> Live listings from local broker networks</p>
              <h1>Find the right <em>property</em> before it disappears.</h1>
              <p className="mp-hero-support">Search the conversations where homes and commercial spaces move first. See what is fresh, then go straight to the broker who shared it.</p>
              <div className="mp-search-wrap"><HomeSearch localities={overview.topLocalities} /></div>
              <p className="mp-search-note">Try a locality, building, broker, BHK, office, retail space, budget, or a full request.</p>
            </div>
            <Card className="mp-pulse">
              <CardContent>
                <div className="mp-pulse-head"><div><p className="mp-label">Live network</p><h2>Fresh from brokers near you</h2></div><span className="mp-live"><span /> Live</span></div>
                <div className="mp-rule" />
                {listings.slice(0, 3).map((row) => {
                  const slug = buildListingSlug({ id: row.id, bhk: row.bhk, micro_market: row.micro_market, building_name: row.building_name, property_type: row.property_type, intent: row.intent, title: row.summary_title }) || String(row.id);
                  return <Link key={row.id} href={`/listings/${slug}/${row.id}`} className="mp-pulse-row"><span>{text(row.micro_market) || "Live market"}</span><strong>{text(row.summary_title) || text(row.building_name) || "Fresh property"}</strong><ArrowRight aria-hidden="true" /></Link>;
                })}
                {!listings.length && <p className="mp-empty">Live inventory will appear as broker conversations are indexed.</p>}
                <Link href="/search" className="mp-text-link">Explore live inventory <ArrowRight aria-hidden="true" /></Link>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="mp-stats" aria-label="Live market snapshot"><div className="mp-container"><p className="mp-label">Market snapshot</p><div className="mp-stat-grid">{stats.map(([value, label, note]) => <Card key={label}><CardContent><strong><CountUp end={value} duration={1400} locale="en-IN" /></strong><span>{label}</span><small>{note}</small></CardContent></Card>)}</div></div></section>

        <section className="mp-section" id="listings"><div className="mp-container"><div className="mp-section-head"><div><p className="mp-label">Fresh inventory</p><h2>Fresh from brokers near you</h2><p>Live residential and commercial listings sourced from active broker conversations.</p></div><Link href="/search" className="mp-text-link">View all listings <ArrowRight aria-hidden="true" /></Link></div><LiveListingTicker />{listings.length > 0 ? <LatestListingsGrid initialListings={listings.map(({ broker_phone: _phone, source_text: _source, ...row }) => row)} /> : <Card className="mp-empty-card"><CardContent>No live listings are available in this market view yet.</CardContent></Card>}</div></section>

        {overview.topLocalities.length > 0 && <section className="mp-section mp-localities" id="localities"><div className="mp-container"><div className="mp-section-head"><div><p className="mp-label">Places worth knowing</p><h2>Browse by locality</h2><p>Start with a neighbourhood, then narrow by budget, asset type, and the details that matter.</p></div><Link href="/localities" className="mp-text-link">All localities <ArrowRight aria-hidden="true" /></Link></div><div className="mp-locality-grid">{overview.topLocalities.slice(0, 8).map((loc) => <Link key={loc.slug} href={`/localities/${loc.slug}`}><div><h3>{loc.locality}</h3><p><MapPin aria-hidden="true" /> {loc.listingCount} live listings</p></div><ArrowRight aria-hidden="true" /></Link>)}</div></div></section>}

        <section className="mp-section mp-process" id="how-it-works"><div className="mp-container"><div className="mp-section-head"><div><p className="mp-label">A shorter route to the right person</p><h2>How it works</h2><p>No account to create, no portal maze to navigate.</p></div></div><div className="mp-process-grid">{processSteps.map(({ number, Icon, title, body }) => <Card key={number}><CardContent><b>{number}</b><Icon aria-hidden="true" /><h3>{title}</h3><p>{body}</p></CardContent></Card>)}</div></div></section>

        <section className="mp-trust"><div className="mp-container mp-trust-grid"><div><p className="mp-label">Why PropAI?</p><h2>Real inventory needs a real trail.</h2><p>See where the listing came from, how fresh it is, and who to speak to next.</p><Link href="/about" className="mp-text-link">Read how PropAI works <ArrowRight aria-hidden="true" /></Link></div><div className="mp-trust-list"><div><MessageSquare aria-hidden="true" /><span><b>Real broker conversations</b><small>Inventory comes from local WhatsApp networks.</small></span></div><div><Clock3 aria-hidden="true" /><span><b>Freshness tracking</b><small>Stale inventory is hidden after 30 days.</small></span></div><div><ShieldCheck aria-hidden="true" /><span><b>Direct WhatsApp connection</b><small>Move from property brief to verified broker.</small></span></div></div></div></section>
        <ShortlistBar />
      </ShortlistProvider>
    </main>
    <SiteFooter />
  </div>;
}
