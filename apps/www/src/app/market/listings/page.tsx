import Link from "next/link";
import { ArrowRight, SlidersHorizontal } from "lucide-react";
import LatestListingsGrid from "@/components/LatestListingsGrid";
import SiteFooter from "@/components/SiteFooter";
import SiteHeader from "@/components/SiteHeader";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ShortlistBar from "@/components/ShortlistBar";
import { getPublicDataOverview } from "@/lib/public-data";

export const revalidate = 300;
export const dynamic = "force-dynamic";

export default async function MarketListingsPage() {
  const overview = await getPublicDataOverview({ skipBuildingScan: true, skipCounts: false, skipLocalities: true, skipActivity: true });
  const listings = overview.recentListings.slice(0, 60).map(({ broker_phone: _phone, source_text: _source, ...row }) => row);
  return <div className="www-shell min-h-screen"><SiteHeader /><ShortlistProvider><main className="www-page-main www-directory-page"><div className="mb-8 flex flex-wrap items-end justify-between gap-5"><div><Link href="/" className="site-back-link">← Back to PropAI</Link><p className="mp-label mt-8">Live marketplace</p><h1 className="mt-2 max-w-3xl text-5xl font-semibold tracking-tight">Browse fresh property listings.</h1><p className="mt-4 max-w-2xl text-base text-[var(--text-secondary)]">Residential and commercial inventory sourced from active broker conversations and ordered by the latest activity.</p></div><Link href="/search" className="site-primary-cta"><SlidersHorizontal className="mr-2 h-4 w-4" aria-hidden="true" /> Search with a brief</Link></div>{listings.length > 0 ? <LatestListingsGrid initialListings={listings} /> : <div className="mp-empty-card rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6">No fresh listings are available right now. New broker inventory appears here as soon as it is structured.</div>}<div className="mt-10 flex justify-center"><Link href="/search" className="mp-text-link">Search by locality or property type <ArrowRight aria-hidden="true" /></Link></div></main><ShortlistBar /></ShortlistProvider><SiteFooter /></div>;
}
