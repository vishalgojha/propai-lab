import Link from "next/link";
import { ArrowRight, BarChart3, MapPin } from "lucide-react";
import { getLocalityInventory } from "@/lib/locality-inventory-server";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

export const metadata = { title: "Live property markets by locality | PropAI", description: "Explore current property inventory, BHK mix, asking-price ranges, and broker activity by locality." };
export const revalidate = 300;
export const dynamic = "force-dynamic";

function labelForType(type: string) {
  if (type === "residential_rent") return "Residential rent";
  if (type === "residential_sale") return "Residential sale";
  if (type === "commercial_rent") return "Commercial rent";
  return "Commercial sale";
}
function formatPrice(value: number | null) {
  if (value == null) return null;
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(value % 10_000_000 ? 1 : 0)} Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(value % 100_000 ? 1 : 0)} Lakh`;
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

export default async function LocalitiesIndexPage() {
  const snapshot = await getLocalityInventory();
  const freshness = new Date(snapshot.asOf).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const active24h = snapshot.localities.reduce((n, l) => n + l.active24h, 0);
  return <div className="www-shell min-h-screen text-[var(--text-primary)]">
    <SiteHeader />
    <main className="www-page-main www-directory-page mx-auto max-w-[1180px] px-4 py-12 lg:px-6 lg:py-16">
      <header className="max-w-3xl">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-secondary)]"><MapPin className="h-3.5 w-3.5" aria-hidden="true" /> Live market coverage</div>
        <h1 className="www-display-heading text-4xl font-semibold tracking-tight lg:text-6xl">Find the market behind the listing.</h1>
        <p className="mt-5 text-lg leading-8 text-[var(--text-secondary)]">Locality-level inventory from active broker conversations, organized by transaction type and configuration—not just a directory of names.</p>
        <p className="mt-3 text-sm text-[var(--text-muted)]">{snapshot.localities.length} localities with {snapshot.totalRecords.toLocaleString("en-IN")} listing records · 30-day window · updated {freshness}</p>
      </header>
      <section className="mt-12 grid gap-4 sm:grid-cols-3" aria-label="Coverage summary">
        {[["Listing records", snapshot.totalRecords.toLocaleString("en-IN"), "Each record remains separately searchable"], ["Active in 24h", active24h.toLocaleString("en-IN"), "Recent broker activity"], ["Needs locality review", snapshot.unmappedRecords.toLocaleString("en-IN"), "Held out of place-level claims"]].map(([title, value, note]) => <div key={title} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">{title}</p><p className="mt-2 text-3xl font-semibold">{value}</p><p className="mt-1 text-sm text-[var(--text-secondary)]">{note}</p></div>)}
      </section>
      <div className="mt-14 flex items-end justify-between gap-4"><div><h2 className="text-2xl font-semibold">Markets with live supply</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Counts are listing records; price ranges use only comparable total quotes.</p></div><Link href="/search" className="hidden items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2.5 text-sm font-semibold text-white sm:inline-flex">Search all listings <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></div>
      <div className="mt-6 grid gap-5 md:grid-cols-2">
        {snapshot.localities.map((loc) => { const top = loc.segments.slice(0, 3); const href = loc.standalonePage ? `/localities/${loc.slug}` : `/search?q=${encodeURIComponent(loc.locality)}`; return <article key={`${loc.city ?? ""}-${loc.slug}`} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 shadow-[var(--shadow)]"><div className="flex items-start justify-between gap-4"><div><h3 className="text-xl font-semibold"><Link href={href} className="hover:underline">{loc.locality}</Link></h3><p className="mt-1 text-sm text-[var(--text-secondary)]">{loc.city ?? "Market area"} · {loc.listingCount.toLocaleString("en-IN")} records</p></div><Link href={href} aria-label={`Explore ${loc.locality}`} className="rounded-full border border-[var(--border-subtle)] p-2 text-[var(--accent-primary)]"><ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></div><div className="mt-5 grid grid-cols-3 gap-3 border-y border-[var(--border-subtle)] py-4 text-sm"><div><p className="text-xs text-[var(--text-muted)]">Rent</p><p className="mt-1 font-semibold">{loc.rentCount.toLocaleString("en-IN")}</p></div><div><p className="text-xs text-[var(--text-muted)]">Sale</p><p className="mt-1 font-semibold">{loc.saleCount.toLocaleString("en-IN")}</p></div><div><p className="text-xs text-[var(--text-muted)]">Fresh 24h</p><p className="mt-1 font-semibold">{loc.active24h.toLocaleString("en-IN")}</p></div></div><div className="mt-4 space-y-2">{top.length === 0 ? <p className="text-sm text-[var(--text-secondary)]">Configuration details are still being resolved.</p> : top.map((segment) => { const range = segment.minPrice != null && segment.maxPrice != null ? `${formatPrice(segment.minPrice)}–${formatPrice(segment.maxPrice)}` : "Price not comparable"; return <div key={`${segment.cardType}-${segment.bhk}`} className="flex min-w-0 items-center justify-between gap-3 text-sm"><span className="min-w-0 truncate">{segment.bhk ?? "Configuration pending"} · {labelForType(segment.cardType)}</span><span className="shrink-0 text-[var(--text-secondary)]">{segment.count} · {range}</span></div>; })}</div><p className="mt-5 flex items-center gap-2 text-xs text-[var(--text-muted)]"><BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />{loc.commercialCount ? `${loc.commercialCount} commercial record${loc.commercialCount === 1 ? "" : "s"} included` : "Residential inventory"}</p></article>; })}
      </div>
      <div className="mt-8 text-center sm:hidden"><Link href="/search" className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-4 py-2.5 text-sm font-semibold text-white">Search all listings <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></div>
    </main><SiteFooter />
  </div>;
}
