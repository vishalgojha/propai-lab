import type { Metadata } from "next";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  MapPin,
  Building2,
  TrendingUp,
  Clock,
  Search,
  MessageSquare,
  ArrowRight,
} from "lucide-react";
import {
  getBuildingBySlug,
  getBuildingListings,
  type BuildingListing,
} from "@/lib/localities";
import { buildListingSlug, toListingCardViewModel, type ListingCardFields } from "@/lib/listing-card";
import { slugify, getServerSupabase } from "@/lib/supabase";
import { buildingTitle, buildingDescription } from "@/lib/seo-copy";
import { JsonLd, getSiteUrl } from "@/lib/seo";
import {
  computeHeroStats,
  generateBuildingSummary,
  getSimilarBuildings,
  getLocalityListingCount,
  getNearbyLocalities,
  getNearbyLandmarks,
  getPopularSearches,
  computeMarketInsights,
  getNearbyBuildings,
  buildBuildingBreadcrumb,
} from "@/lib/building-intelligence";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ListingTile from "@/components/ListingTile";
import { ShortlistProvider } from "@/components/ShortlistProvider";

type Params = { params: Promise<{ slug: string }> };

const getBuildingBySlugCached = cache(getBuildingBySlug);
const getBuildingListingsCached = cache(getBuildingListings);

export const revalidate = 300;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const building = await getBuildingBySlugCached(slug);
  if (!building) return { title: "Building not found — PropAI" };
  const listings = await getBuildingListingsCached(building.name, building.microMarket, building.id);
  let saleCount = 0;
  let rentCount = 0;
  for (const l of listings) {
    const i = (l.intent || "").toLowerCase();
    if (i === "rent" || i === "rental" || i === "lease") rentCount += 1;
    else if (i === "sale" || i === "sell" || i === "buy") saleCount += 1;
  }
  return {
    title: buildingTitle(building.name),
    description: buildingDescription({
      name: building.name,
      locality: building.microMarket,
      listingCount: listings.length,
      saleCount,
      rentCount,
    }),
  };
}

function toCardFields(row: BuildingListing): ListingCardFields {
  return {
    id: row.id,
    bhk: row.bhk,
    price: row.price,
    price_unit: row.price_unit,
    price_model: row.price_model,
    price_per_sqft: row.price_per_sqft,
    area_sqft: null,
    furnishing: row.furnishing,
    intent: row.intent,
    asset_type: row.asset_type,
    property_type: row.property_type,
    micro_market: null,
    building_name: null,
    landmark_name: null,
    location_label: null,
    broker_name: row.broker_name,
    broker_phone: row.broker_phone,
    last_seen: row.last_seen,
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function RelatedLinks({
  heading,
  links,
  icon,
}: {
  heading: string;
  links: Array<{ label: string; href: string }>;
  icon?: React.ReactNode;
}) {
  if (!links || links.length === 0) return null;
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
        {icon}
        {heading}
      </h2>
      <div className="flex flex-wrap gap-2">
        {links.map((link) => (
          <Link
            key={link.href + link.label}
            href={link.href}
            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--www-panel)] px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:border-[var(--accent-forest)] hover:text-[var(--accent-forest)] transition-all"
          >
            {link.label}
            <ArrowRight className="h-3 w-3 opacity-50" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </section>
  );
}

function StatBlock({
  label,
  value,
  icon,
}: {
  label: string;
  value: string | null;
  icon?: React.ReactNode;
}) {
  if (!value) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
        {icon}
        {label}
      </div>
      <div className="text-lg font-semibold text-white">{value}</div>
    </div>
  );
}

export default async function BuildingPage({ params }: Params) {
  const { slug } = await params;
  const building = await getBuildingBySlugCached(slug);
  if (!building) notFound();

  const listings = await getBuildingListingsCached(building.name, building.microMarket, building.id);

  const siteUrl = getSiteUrl();
  const stats = computeHeroStats(listings);
  const summary = generateBuildingSummary(building, listings, stats);
  const marketInsights = computeMarketInsights(listings);
  const saleCount = listings.filter((listing) => ["sale", "sell", "buy"].includes((listing.intent || "").toLowerCase())).length;
  const rentCount = listings.filter((listing) => ["rent", "rental", "lease"].includes((listing.intent || "").toLowerCase())).length;
  const observedTypes = Array.from(new Set(listings.map((listing) => listing.asset_type).filter(Boolean))).join(" · ");

  // Parallel section data fetching
  const [
    similarBuildings,
    localityCount,
    nearbyLocalities,
    nearbyLandmarks,
  ] = await Promise.all([
    getSimilarBuildings(building.name, building.microMarket),
    getLocalityListingCount(building.microMarket),
    getNearbyLocalities(building.microMarket),
    getNearbyLandmarks(building.microMarket),
  ]);
  const nearbyBuildings = similarBuildings;

  const popularSearches = getPopularSearches(building.microMarket, stats.bhkRange);

  const bhkRange = stats.bhkRange || null;
  const verifiedAddress = building.enrichmentConfidence != null && building.enrichmentConfidence >= 0.99;

  const breadcrumbSchema = buildBuildingBreadcrumb(siteUrl, building.name, building.microMarket);

  const buildingJsonLd = {
    "@context": "https://schema.org",
    "@type": "Residence",
    name: building.name,
    url: `${siteUrl}/buildings/${slug}`,
    address: verifiedAddress && building.address
      ? {
          "@type": "PostalAddress",
          streetAddress: building.address,
          addressLocality: building.microMarket || "Mumbai",
          addressRegion: "MH",
          addressCountry: "IN",
        }
      : undefined,
    ...(building.developer
      ? { developer: { "@type": "Organization", name: building.developer } }
      : {}),
    ...(stats.listingCount > 0
      ? {
          numberOfAvailableUnits: stats.listingCount,
        }
      : {}),
  };

  const listingItems = listings.flatMap((row, index) => {
    const slug = buildListingSlug({ id: row.id, bhk: row.bhk, micro_market: row.micro_market, building_name: row.building_name || building.name, property_type: row.property_type, intent: row.intent, title: row.title });
    return slug ? [{
      "@type": "ListItem",
      position: index + 1,
      url: `${siteUrl}/listings/${slug}/${row.id}`,
      name: row.title || `${row.bhk || "Property"} ${row.intent === "rent" ? "for rent" : "for sale"} at ${building.name}`,
    }] : [];
  });
  const listingItemList = listingItems.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${building.name} property listings`,
    numberOfItems: listingItems.length,
    itemListElement: listingItems,
  } : null;

  return (
    <ShortlistProvider>
      <div className="www-shell min-h-screen">
        <SiteHeader />
        <JsonLd data={breadcrumbSchema} />
        <JsonLd data={buildingJsonLd} />
        {listingItemList && <JsonLd data={listingItemList} />}

        <main className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10 lg:py-14">

          {/* Breadcrumb */}
          <nav className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap text-[12px] text-zinc-500 mb-7" aria-label="Breadcrumb">
            <Link href="/" className="hover:text-white transition-colors">Home</Link>
            <span>/</span>
            <Link href="/localities" className="hover:text-white transition-colors">Mumbai</Link>
            {building.microMarket && (
              <>
                <span>/</span>
                <Link
                  href={`/localities/${slugify(building.microMarket)}`}
                  className="hover:text-white transition-colors"
                >
                  {building.microMarket}
                </Link>
              </>
            )}
            <span>/</span>
            <span className="text-zinc-300">{building.name}</span>
          </nav>

          {/* Hero Section */}
          <header className="relative mb-8 overflow-hidden rounded-[1.5rem] border border-[var(--border-subtle)] bg-[var(--www-panel)] px-5 py-7 shadow-[0_18px_50px_rgba(63,90,58,.08)] sm:px-8 sm:py-9 lg:px-10">
            <div className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[var(--accent-soft)] opacity-60 blur-3xl" />
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--accent-forest)]">Live building profile</p>
                <h1 className="max-w-3xl text-[clamp(2.1rem,5vw,4.2rem)] leading-[.98] font-semibold tracking-[-.04em] text-[var(--text-primary)] mb-5">
                  {building.name}
                </h1>
                <div className="flex flex-wrap items-center gap-2">
                  {building.microMarket && (
                    <Link
                      href={`/localities/${slugify(building.microMarket)}`}
                      className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-forest)] hover:border-[var(--accent-forest)] transition-colors"
                    >
                      <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                      {building.microMarket}
                    </Link>
                  )}
                  {stats.listingCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)]">
                      <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                      {stats.listingCount} listing{stats.listingCount === 1 ? "" : "s"}
                    </span>
                  )}
                  {stats.avgPricePerSqft && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400">
                      <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                      {stats.avgPricePerSqft}
                    </span>
                  )}
                </div>
                <p className="mt-6 max-w-2xl text-[15px] leading-7 text-[var(--text-secondary)]">{summary}</p>
              </div>
              <aside className="relative mt-5 w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-alt-section)] p-5 sm:max-w-xs lg:mt-0">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.14em] text-[var(--accent-forest)]"><span className="h-2 w-2 rounded-full bg-[var(--accent-primary)]" aria-hidden="true" />Current signal</div>
                <p className="mt-4 text-3xl font-semibold tracking-[-.03em] text-[var(--text-primary)]">{stats.listingCount}</p>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">fresh broker listing{stats.listingCount === 1 ? "" : "s"} matched here</p>
                <p className="mt-5 border-t border-[var(--border-subtle)] pt-4 text-xs leading-5 text-[var(--text-secondary)]">Observed in PropAI&apos;s WhatsApp network. Availability can change as brokers post new messages.</p>
              </aside>
            </div>

            {verifiedAddress && building.address && (
              <p className="relative mt-6 max-w-2xl text-[14px] leading-6 text-[var(--text-secondary)]">
                {building.address}
              </p>
            )}
            {building.developer && (
              <p className="relative mt-1 text-sm text-[var(--text-secondary)]">Developer: {building.developer}</p>
            )}
          </header>

          <nav className="sticky top-[80px] z-20 -mx-4 my-6 overflow-x-auto border-y border-[var(--border-subtle)] bg-[var(--bg-base)]/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border" aria-label="Building sections">
            <div className="flex min-w-max items-center gap-5 text-sm font-medium text-[var(--text-secondary)]"><a href="#listings" className="hover:text-[var(--accent-forest)]">Live listings</a><a href="#facts" className="hover:text-[var(--accent-forest)]">Building facts</a><a href="#locality" className="hover:text-[var(--accent-forest)]">Locality context</a><a href="#nearby" className="hover:text-[var(--accent-forest)]">Nearby buildings</a></div>
          </nav>

          {/* Stats Row */}
          {stats.listingCount > 0 && (
            <section className="mb-12 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatBlock label="Total Listings" value={stats.listingCount.toLocaleString("en-IN")} icon={<Building2 className="h-3 w-3" />} />
              <StatBlock label="For Rent" value={rentCount ? rentCount.toLocaleString("en-IN") : null} icon={<TrendingUp className="h-3 w-3" />} />
              <StatBlock label="For Sale" value={saleCount ? saleCount.toLocaleString("en-IN") : null} icon={<TrendingUp className="h-3 w-3" />} />
              <StatBlock label="BHK Range" value={stats.bhkRange} icon={<Building2 className="h-3 w-3" />} />
              <StatBlock label="Last Updated" value={formatDate(stats.lastUpdated)} icon={<Clock className="h-3 w-3" />} />
            </section>
          )}

          {/* About the Building */}
          <section className="mb-12 max-w-3xl">
            <h2 className="text-lg font-semibold text-white mb-3">About {building.name}</h2>
            <p className="text-[15px] leading-relaxed text-zinc-400">{summary}</p>
          </section>

          <section id="facts" className="mb-12 grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]">
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--www-panel)] p-6 sm:p-8">
              <h2 className="text-2xl font-semibold tracking-[-.025em] text-[var(--text-primary)]">What PropAI has observed</h2>
              <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[var(--text-secondary)]">This profile is assembled from recent broker messages. It describes the signal we have captured, not a complete census of the building.</p>
              <dl className="mt-7 grid gap-5 border-t border-[var(--border-subtle)] pt-6 sm:grid-cols-2">
                <div><dt className="text-xs uppercase tracking-[.13em] text-[var(--text-secondary)]">Configurations seen</dt><dd className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{stats.bhkRange || "Not stated in current messages"}</dd></div>
                <div><dt className="text-xs uppercase tracking-[.13em] text-[var(--text-secondary)]">Asset type</dt><dd className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{observedTypes || "Not stated in current messages"}</dd></div>
                {stats.avgRent && <div><dt className="text-xs uppercase tracking-[.13em] text-[var(--text-secondary)]">Observed average rent</dt><dd className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{stats.avgRent}</dd></div>}
                {stats.avgSalePrice && <div><dt className="text-xs uppercase tracking-[.13em] text-[var(--text-secondary)]">Observed average sale price</dt><dd className="mt-1 text-lg font-semibold text-[var(--text-primary)]">{stats.avgSalePrice}</dd></div>}
              </dl>
            </div>
            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-alt-section)] p-6 sm:p-8">
              <h2 className="text-xl font-semibold tracking-[-.02em] text-[var(--text-primary)]">Building details</h2>
              <dl className="mt-6 space-y-5 text-sm">
                <div><dt className="text-[var(--text-secondary)]">Locality</dt><dd className="mt-1 font-medium text-[var(--text-primary)]">{building.microMarket || "Not resolved yet"}</dd></div>
                <div><dt className="text-[var(--text-secondary)]">Address</dt><dd className="mt-1 font-medium text-[var(--text-primary)]">{verifiedAddress && building.address ? building.address : "Address enrichment pending"}</dd></div>
                <div><dt className="text-[var(--text-secondary)]">Data freshness</dt><dd className="mt-1 font-medium text-[var(--text-primary)]">{stats.lastUpdated ? `Last observed ${formatDate(stats.lastUpdated)}` : "No recent activity"}</dd></div>
              </dl>
            </div>
          </section>

          {(verifiedAddress && building.address) || building.developer ? (
            <section className="mb-12 max-w-3xl rounded-xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="text-lg font-semibold text-white mb-4">Verified building details</h2>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                {verifiedAddress && building.address && (
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">Address</dt>
                    <dd className="mt-1 text-zinc-300">{building.address}</dd>
                  </div>
                )}
                {building.developer && (
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">Developer</dt>
                    <dd className="mt-1 text-zinc-300">{building.developer}</dd>
                  </div>
                )}
              </dl>
            </section>
          ) : null}

          {/* Listings */}
          <section id="listings" className="mb-12 rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-alt-section)] p-4 sm:p-6 lg:p-8">
            <h2 className="text-xl font-semibold text-white mb-6">
              {listings.length > 0
                ? `${listings.length} Active Listing${listings.length === 1 ? "" : "s"}`
                : "No Active Listings Yet"}
            </h2>

            {listings.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center">
                <p className="text-zinc-400">
                  No broker activity has been tracked for {building.name} yet. Listings appear
                  automatically as soon as brokers post in our WhatsApp network.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {listings.map((row) => {
                  const card = toListingCardViewModel(toCardFields(row), false, building.microMarket);
                  return <ListingTile key={row.id} card={card} buildingName={building.name} />;
                })}
              </div>
            )}
          </section>

          {/* Similar Buildings Nearby */}
          {similarBuildings.length > 0 && (
            <section id="nearby" className="mb-12">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Building2 className="h-5 w-5 text-zinc-500" />
                Similar Buildings in {building.microMarket}
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {similarBuildings.map((b) => (
                  <Link
                    key={b.slug}
                    href={`/buildings/${b.slug}`}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:border-green-400/30 hover:bg-green-400/5 transition-all group"
                  >
                    <div>
                      <div className="text-sm font-medium text-white group-hover:text-green-200 transition-colors">{b.name}</div>
                      <div className="text-[12px] text-zinc-500">
                        {b.listingCount} listing{b.listingCount === 1 ? "" : "s"}
                        {b.avgPrice && (
                          <span className="ml-1.5">
                            · {formatPrice(b.avgPrice)} {b.priceUnit || ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-zinc-600 group-hover:text-green-400 transition-colors" />
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* More Properties in Locality */}
          {building.microMarket && localityCount > 0 && (
            <section className="mb-12">
              <h2 className="text-lg font-semibold text-white mb-3">
                More Properties in {building.microMarket}
              </h2>
              <Link
                href={`/localities/${slugify(building.microMarket)}`}
                className="inline-flex items-center gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--www-panel)] px-5 py-3 text-sm text-[var(--text-secondary)] hover:border-[var(--accent-forest)] hover:text-[var(--accent-forest)] transition-all group"
              >
                View all {localityCount.toLocaleString("en-IN")} listings in {building.microMarket}
                <ArrowRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
              </Link>
            </section>
          )}

          {/* Related Links: Nearby Localities, Landmarks, Popular Searches */}
          <div className="space-y-8 mb-12">
            <RelatedLinks
              heading="Nearby Localities"
              links={nearbyLocalities}
              icon={<MapPin className="h-5 w-5 text-zinc-500" />}
            />
            <RelatedLinks
              heading="Nearby Landmarks"
              links={nearbyLandmarks}
              icon={<MapPin className="h-5 w-5 text-zinc-500" />}
            />
            <RelatedLinks
              heading="Popular Searches"
              links={popularSearches}
              icon={<Search className="h-5 w-5 text-zinc-500" />}
            />
          </div>

          {/* Market Insights */}
          {marketInsights.length > 0 && (
            <section className="mb-12">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-zinc-500" />
                Market Insights
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                {marketInsights.map((insight) => (
                  <div
                    key={insight.label}
                    className="rounded-xl border border-white/10 bg-white/5 px-4 py-3"
                  >
                    <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{insight.label}</div>
                    <div className="text-base font-semibold text-white">{insight.value}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* People Also Viewed */}
          {nearbyBuildings.length > 0 && (
            <section className="mb-12">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <Building2 className="h-5 w-5 text-zinc-500" />
                People Also Viewed
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {nearbyBuildings.map((b) => (
                  <Link
                    key={b.slug}
                    href={`/buildings/${b.slug}`}
                    className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 hover:border-green-400/30 hover:bg-green-400/5 transition-all group"
                  >
                    <div>
                      <div className="text-sm font-medium text-white group-hover:text-green-200 transition-colors">{b.name}</div>
                      <div className="text-[12px] text-zinc-500">
                        {b.listingCount} listing{b.listingCount === 1 ? "" : "s"}
                        {b.avgPrice && (
                          <span className="ml-1.5">
                            · {formatPrice(b.avgPrice)} {b.priceUnit || ""}
                          </span>
                        )}
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-zinc-600 group-hover:text-green-400 transition-colors" />
                  </Link>
                ))}
              </div>
            </section>
          )}

        </main>
        <SiteFooter />
      </div>
    </ShortlistProvider>
  );
}

function formatPrice(price: number): string {
  if (price >= 1_00_00_000) return `₹${(price / 1_00_00_000).toFixed(1).replace(/\.0$/, "")} Cr`;
  if (price >= 1_00_000) return `₹${(price / 1_00_000).toFixed(1).replace(/\.0$/, "")} Lakh`;
  if (price >= 1_000) return `₹${(price / 1_000).toFixed(0)}K`;
  return `₹${price.toLocaleString("en-IN")}`;
}
