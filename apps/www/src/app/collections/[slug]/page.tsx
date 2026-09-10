import Link from "next/link";
import { ArrowLeft, ArrowRight, MapPin } from "lucide-react";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { getPublicCollection } from "@/lib/collections";

type Params = { params: Promise<{ slug: string }> };
export const dynamic = "force-dynamic";

export default async function CollectionPage({ params }: Params) {
  const { slug } = await params;
  const data = await getPublicCollection(slug);
  if (!data) notFound();
  const { collection, listings } = data;
  return <div className="www-shell min-h-screen text-[var(--text-primary)]"><SiteHeader /><main className="www-page-main mx-auto max-w-[1280px] px-4 py-10 lg:px-6 lg:py-14"><Link href="/collections" className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"><ArrowLeft className="h-4 w-4" aria-hidden="true" />All collections</Link><header className="mt-10 max-w-3xl"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">{collection.transactionType === "rent" ? "Rent" : "Sale"}{collection.bhk ? ` · ${collection.bhk}` : ""}</p><h1 className="mt-3 text-4xl font-semibold tracking-tight lg:text-5xl">{collection.title}</h1><p className="mt-5 text-lg leading-8 text-[var(--text-secondary)]">{collection.description}</p><p className="mt-4 text-sm text-[var(--text-muted)]">{collection.listingCount} current listing{collection.listingCount === 1 ? "" : "s"} · refreshed from the last {collection.freshnessDays} days of broker activity</p></header>{listings.length === 0 ? <p className="mt-12 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-8 text-[var(--text-secondary)]">This collection has no current listings.</p> : <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{listings.map((listing) => <article key={`${listing.cardType}-${listing.id}`} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5"><div className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]"><span>{listing.bhk || "Property"}</span><span>{listing.priceLabel}</span></div><h2 className="mt-4 text-lg font-semibold leading-7"><Link href={listing.href} className="hover:underline">{listing.title}</Link></h2><div className="mt-4 space-y-2 text-sm text-[var(--text-secondary)]">{listing.buildingName && <p>{listing.buildingName}</p>}{listing.locality && <p className="flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />{listing.locality}</p>}{listing.areaSqft && <p>{listing.areaSqft.toLocaleString("en-IN")} sqft</p>}{listing.furnishing && <p>{listing.furnishing}</p>}</div><Link href={listing.href} className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--accent-primary)]">View listing <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></article>)}</div>}</main><SiteFooter /></div>;
}
