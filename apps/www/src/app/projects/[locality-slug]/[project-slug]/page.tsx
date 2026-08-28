import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Building2, ExternalLink, MapPin, RefreshCw } from "lucide-react";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ListingTile from "@/components/ListingTile";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import { toListingCardViewModel, type ListingCardFields } from "@/lib/listing-card";
import { buildBreadcrumb, JsonLd, getSiteUrl } from "@/lib/seo";
import { slugify } from "@/lib/supabase";
import { getProjectPage, projectFactValue, projectIsIndexable, type ProjectPageData } from "@/lib/projects";

type Params = { params: Promise<{ "locality-slug": string; "project-slug": string }> };
export const revalidate = 300;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { "locality-slug": locality, "project-slug": slug } = await params;
  const data = await getProjectPage(locality, slug);
  if (!data) return { title: "Project not found — PropAI", robots: { index: false, follow: true } };
  const indexable = projectIsIndexable(data);
  const facts = data.facts.length;
  return {
    title: `${data.project.canonical_name}${data.project.locality ? `, ${data.project.locality}` : ""} — PropAI`,
    description: `${data.project.canonical_name}${data.project.developer_name ? ` by ${data.project.developer_name}` : ""}${data.project.locality ? ` in ${data.project.locality}` : ""}. Source-grounded project information and live broker activity from PropAI.`,
    robots: indexable ? { index: true, follow: true } : { index: false, follow: true },
    other: { "x-project-facts": String(facts) },
  };
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return <div className="border-b border-white/10 py-4"><dt className="text-xs uppercase tracking-[0.16em] text-zinc-400">{label}</dt><dd className="mt-1 text-[15px] text-zinc-200">{value}</dd></div>;
}

function sourceLabel(type: string) {
  return type === "maharera" ? "MahaRERA" : type === "developer" ? "developer source" : "portal source";
}

function toCardFields(row: ProjectPageData["listings"][number]): ListingCardFields {
  return {
    id: row.id, bhk: row.bhk, price: row.price, price_unit: row.price_unit,
    price_raw_text: row.price_raw_text, price_model: row.price_model,
    price_per_sqft: row.price_per_sqft ?? null, area_sqft: row.area_sqft ?? null,
    furnishing: row.furnishing, intent: row.intent, asset_type: row.asset_type,
    property_type: row.property_type, micro_market: row.micro_market,
    locality_raw: row.locality_raw, locality_resolved: row.locality_resolved,
    view: row.view, floor_description: row.floor_description,
    building_name: row.building_name, broker_name: row.broker_name,
    broker_id: row.broker_id, broker_phone: row.broker_phone,
    last_seen: row.last_seen, first_seen: row.first_seen,
    times_seen: row.times_seen, title: row.title,
    representative_raw_message_id: row.representative_raw_message_id,
    latest_raw_message_id: row.latest_raw_message_id,
  };
}

export default async function ProjectPage({ params }: Params) {
  const { "locality-slug": localitySlug, "project-slug": projectSlug } = await params;
  const data = await getProjectPage(localitySlug, projectSlug);
  if (!data) notFound();
  const siteUrl = getSiteUrl();
  const url = `${siteUrl}/projects/${slugify(data.project.locality)}/${data.project.slug}`;
  const primarySource = data.sources[0];
  const indexable = projectIsIndexable(data);
  const modified = data.project.last_activity_changed_at || data.project.last_fact_changed_at || data.project.last_crawled_at;
  const breadcrumb = buildBreadcrumb(siteUrl, [{ name: "Home", url: "/" }, { name: data.project.locality || "Projects", url: `/localities/${slugify(data.project.locality)}` }, { name: data.project.canonical_name, url }]);
  const projectSchema = { "@context": "https://schema.org", "@type": "Residence", name: data.project.canonical_name, url, ...(data.project.developer_name ? { developer: { "@type": "Organization", name: data.project.developer_name } } : {}), ...(data.project.locality ? { address: { "@type": "PostalAddress", addressLocality: data.project.locality, addressCountry: "IN" } } : {}), ...(modified ? { dateModified: modified } : {}) };

  const listingCards = data.listings.slice(0, 6).map((listing) => toListingCardViewModel(toCardFields(listing), false, data.project.locality));
  return <ShortlistProvider>
    <SiteHeader />
    <main className="mx-auto max-w-6xl px-5 py-10 text-white lg:px-8 lg:py-16">
      <JsonLd data={breadcrumb} /><JsonLd data={projectSchema} />
      <nav className="mb-10 text-sm text-zinc-400" aria-label="Breadcrumb"><Link href="/">Home</Link><span className="mx-2">/</span><Link href={`/localities/${slugify(data.project.locality)}`}>{data.project.locality}</Link><span className="mx-2">/</span><span className="text-zinc-200">{data.project.canonical_name}</span></nav>
      <header className="max-w-3xl border-b border-white/10 pb-10">
        <p className="mb-4 flex items-center gap-2 text-sm text-emerald-700"><MapPin className="h-4 w-4" />{data.project.locality}{data.project.city ? ` · ${data.project.city}` : ""}</p>
        <h1 className="font-serif text-5xl leading-[0.98] tracking-[-0.035em] text-white sm:text-6xl">{data.project.canonical_name}</h1>
        {data.project.developer_name && <p className="mt-5 text-lg text-zinc-300">Developed by {data.project.developer_name}</p>}
        {!indexable && <p className="mt-5 text-sm text-zinc-400">This project page is being rechecked against its source. The information below is not currently eligible for search indexing.</p>}
      </header>

      <div className="grid gap-12 py-12 lg:grid-cols-[1fr_0.72fr]">
        <section aria-labelledby="project-information">
          <div className="mb-5 flex items-end justify-between gap-4"><h2 id="project-information" className="text-2xl font-semibold text-white">Project information</h2>{primarySource && <a className="inline-flex items-center gap-1 text-sm text-emerald-400 underline underline-offset-4" href={primarySource.source_url} rel="nofollow noopener noreferrer">Sourced from {sourceLabel(primarySource.source_type)} <ExternalLink className="h-3.5 w-3.5" /></a>}</div>
          <dl className="max-w-2xl">
            <Fact label="Address" value={projectFactValue(data, "address")} /><Fact label="Locality" value={projectFactValue(data, "locality") || data.project.locality} /><Fact label="Unit configurations" value={projectFactValue(data, "bhk_range")} /><Fact label="Price range" value={projectFactValue(data, "price_range")} /><Fact label="Possession status" value={projectFactValue(data, "possession_status")} /><Fact label="RERA number" value={projectFactValue(data, "rera_number")} /><Fact label="Amenities" value={projectFactValue(data, "amenities")} />
          </dl>
          {data.documents[0] && <p className="mt-6 flex items-center gap-2 text-xs text-zinc-400"><RefreshCw className="h-3.5 w-3.5" />Source-verified project information</p>}
        </section>

        <aside className="self-start border-t-2 border-white/30 pt-5" aria-labelledby="broker-activity"><h2 id="broker-activity" className="text-2xl font-semibold text-white">Live broker activity</h2><p className="mt-2 text-sm text-zinc-300">Sourced from PropAI&apos;s WhatsApp network</p>{data.buildingSlug && <Link href={`/buildings/${data.buildingSlug}`} className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-emerald-400 underline underline-offset-4"><Building2 className="h-4 w-4" />View the linked building page</Link>}{listingCards.length === 0 ? <p className="mt-8 text-sm leading-6 text-zinc-300">No current broker listings are linked to this project in PropAI&apos;s captured network.</p> : <div className="mt-7 space-y-4">{listingCards.map((card, index) => <ListingTile key={card.href || index} card={card} />)}</div>}</aside>
      </div>
    </main>
    <SiteFooter />
  </ShortlistProvider>;
}
