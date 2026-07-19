import type { Metadata } from "next";
import Link from "next/link";
import { slugify } from "@/lib/supabase";
import { notFound } from "next/navigation";
import { JsonLd, buildRealEstateListing, buildBreadcrumb, getSiteUrl } from "@/lib/seo";
import { listingTitle, listingDescription } from "@/lib/seo-copy";
import {
  MapPin,
  MessageSquare,
  ShieldCheck,
  Clock,
  BedDouble,
  Ruler,
  Sofa,
  Building2,
  Eye,
  Home,
  Building,
  Flag,
  Target,
  Phone,
  ArrowLeft,
  ChevronRight,
  Tag,
} from "lucide-react";
import { getListingById } from "@/lib/localities";
import { toListingCardViewModel, type ListingCardFields, type ListingSpecItem } from "@/lib/listing-card";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ListingSpecs from "@/components/ListingSpecs";

type Params = { params: Promise<{ id: string }> };

const SPEC_ICONS: Record<ListingSpecItem["kind"], typeof BedDouble> = {
  bhk: BedDouble,
  area: Ruler,
  furnishing: Sofa,
  floor: Building2,
  view: Eye,
  type: Tag,
};

const KindIcon = ({ kind, className }: { kind: string | null; className?: string }) =>
  kind === "Commercial" ? (
    <Building className={className} strokeWidth={1.75} aria-hidden="true" />
  ) : (
    <Home className={className} strokeWidth={1.75} aria-hidden="true" />
  );

function toCardFields(row: NonNullable<Awaited<ReturnType<typeof getListingById>>>): ListingCardFields {
  return {
    id: row.id,
    bhk: row.bhk,
    price: row.price,
    price_unit: row.price_unit,
    area_sqft: row.area_sqft,
    furnishing: row.furnishing,
    intent: row.intent,
    asset_type: row.asset_type,
    property_type: row.property_type,
    micro_market: row.micro_market,
    building_name: row.building_name,
    landmark_name: row.landmark_name,
    location_label: row.location_label,
    floor_description: row.floor_description,
    view: row.view,
    title: row.title,
    broker_name: row.broker_name,
    broker_phone: row.broker_phone,
    last_seen: row.last_seen,
  };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  let listing;
  try {
    listing = await getListingById(Number(id));
  } catch {
    return { title: "Listing not found — PropAI" };
  }
  if (!listing) return { title: "Listing not found — PropAI" };
  let card;
  try {
    card = toListingCardViewModel(toCardFields(listing), false);
  } catch {
    return { title: "Listing not found — PropAI" };
  }
  const isRent = /month/i.test(card.priceLabel);
  const dealType = isRent ? "For rent" : "For sale";
  return {
    title: listingTitle(card),
    description: listingDescription({
      dealType,
      title: card.title,
      locality: card.locality,
      specRow: card.specRow,
    }),
  };
}

export default async function ListingPage({ params }: Params) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  let listing;
  try {
    listing = await getListingById(numericId);
  } catch (err) {
    console.error("getListingById failed:", err);
    notFound();
  }
  if (!listing) notFound();

  let card;
  try {
    card = toListingCardViewModel(toCardFields(listing), false);
  } catch (err) {
    console.error("toListingCardViewModel failed:", err);
    notFound();
  }
  const brokerInitials = (card.brokerName || "PR")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const isRent = /month/i.test(card.priceLabel);
  const dealType = isRent ? "For rent" : "For sale";

  const siteUrl = getSiteUrl();
  const listingUrl = `${siteUrl}/listings/${numericId}`;
  const priceUnit = (listing.price_unit || "").toLowerCase();
  let priceINR: number | null = null;
  if (typeof listing.price === "number" && !Number.isNaN(listing.price)) {
    if (priceUnit.includes("cr")) priceINR = listing.price * 1_00_00_000;
    else if (priceUnit.includes("lac") || priceUnit.includes("lakh")) priceINR = listing.price * 1_00_000;
    else if (priceUnit.includes("k")) priceINR = listing.price * 1_000;
    else priceINR = listing.price;
  }
  const listingSchema = buildRealEstateListing({
    url: listingUrl,
    id: numericId,
    title: card.title || `${listing.bhk || ""} ${listing.property_type || "property"} in ${card.locality || "Mumbai"}`.trim(),
    description: `${dealType} — ${card.title || "property"} in ${card.locality || "Mumbai"}. Listed via live WhatsApp broker network, routed directly to the posting broker.`,
    price: priceINR,
    priceCurrency: "INR",
    dealType,
    bedrooms: listing.bhk,
    areaSqft: typeof listing.area_sqft === "number" ? listing.area_sqft : null,
    locality: card.locality,
    brokerName: card.brokerName,
    datePosted: listing.last_seen,
  });
  const breadcrumbSchema = buildBreadcrumb(siteUrl, [
    { name: "Home", url: "/" },
    ...(card.locality && card.localitySlug
      ? [{ name: card.locality, url: `/localities/${card.localitySlug}` }]
      : []),
    { name: card.title || `Listing ${numericId}`, url: `/listings/${numericId}` },
  ]);

  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <JsonLd data={listingSchema} />
      <JsonLd data={breadcrumbSchema} />
      <main className="mx-auto max-w-5xl px-4 py-8 lg:px-6 lg:py-12">
        <button
          onClick={() => history.back()}
          className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-400 transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to listings
        </button>

        <div className="mb-6 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
          <Link href="/search" className="hover:text-white transition-colors">
            Home
          </Link>
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
          {card.locality && (
            <>
              <Link
                href={`/localities/${card.localitySlug}`}
                className="hover:text-white transition-colors"
              >
                {card.locality}
              </Link>
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </>
          )}
          <span className="text-zinc-400">{listing.building_name || card.title}</span>
        </div>

        <div className="grid grid-cols-1 gap-7 lg:grid-cols-[1fr_300px]">
          {/* Main column */}
          <div>
            {/* Media hero */}
            <div className="relative flex h-64 w-full items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-green-500/15 via-zinc-900 to-zinc-950">
              <KindIcon
                kind={card.assetTypeLabel}
                className="h-16 w-16 text-zinc-700"
              />
              <div className="absolute left-3 top-3">
                {card.assetTypeLabel && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[11px] font-medium text-zinc-100 backdrop-blur">
                    <KindIcon kind={card.assetTypeLabel} className="h-3 w-3" />
                    {card.assetTypeLabel}
                  </span>
                )}
              </div>
              <div className="absolute right-3 top-3">
                <span
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                    card.statusTone === "available"
                      ? "border border-green-400/20 bg-green-400/10 text-green-300"
                      : "border border-amber-400/20 bg-amber-400/10 text-amber-200"
                  }`}
                >
                  {card.statusLabel}
                </span>
              </div>
            </div>

            {/* Header */}
            <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-1.5 text-sm text-zinc-400">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>
                    {card.locality}
                    {listing.micro_market && listing.micro_market !== card.locality
                      ? ` · ${listing.micro_market}`
                      : ""}
                  </span>
                </div>
                <h1 className="mt-1 text-[28px] font-bold leading-[1.15] text-white lg:text-[34px]">
                  {listing.building_name || card.title}
                </h1>
              </div>
              <div className="text-right">
                <div className="text-3xl font-semibold text-white lg:text-4xl">{card.priceLabel}</div>
                <span className="mt-1 inline-block rounded-md bg-green-400/10 px-2 py-0.5 text-xs font-semibold text-green-300">
                  {dealType}
                </span>
              </div>
            </div>

            {/* Specs grid */}
            {card.specItems.length > 0 && (
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {card.specItems.map((s, i) => {
                  const Icon = SPEC_ICONS[s.kind] ?? BedDouble;
                  return (
                    <div
                      key={`${s.kind}-${i}`}
                      className="flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-950/90 p-3.5"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-green-400" aria-hidden="true" />
                      <div>
                        <div className="text-[10px] uppercase tracking-wide text-zinc-500">{s.kind}</div>
                        <div className="text-sm font-semibold text-white">{s.label}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Description */}
            {listing.location_label && (
              <div className="mt-7">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  About this listing
                </h2>
                <p className="text-sm leading-relaxed text-zinc-300">{listing.location_label}</p>
              </div>
            )}

            {/* Landmarks / nearby */}
            {card.locality && (
              <div className="mt-7">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  Nearby
                </h2>
                <ul className="space-y-1.5">
                  <li className="flex items-center gap-2 text-sm text-zinc-300">
                    <Building2 className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                    {card.locality}
                  </li>
                </ul>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="relative">
            <div className="sticky top-6 rounded-2xl border border-white/10 bg-zinc-950/90 p-5">
              <button
                className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-md text-zinc-500 transition-colors hover:border-white/20 hover:bg-white/5 hover:text-amber-400"
                aria-label="Report incorrect information for this listing"
                title="Report incorrect info"
              >
                <Flag className="h-3 w-3" strokeWidth={2} aria-hidden="true" />
              </button>

              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-400/15 text-lg font-bold text-green-300">
                {brokerInitials}
              </div>
              <div className="mt-3 flex items-center justify-center gap-1.5 text-center text-base font-semibold text-white">
                {card.brokerName || "Verified network"}
                {card.brokerName && (
                  <ShieldCheck className="h-4 w-4 shrink-0 text-green-400" aria-hidden="true" />
                )}
              </div>
              <div className="mt-1 text-center text-xs text-zinc-500">
                Active listings on PropAI
              </div>

              <div className="mt-5 flex flex-col gap-2.5">
                {card.waLink ? (
                  <a
                    href={card.waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-green-400 px-5 py-3 text-sm font-semibold text-black transition-colors hover:bg-green-300"
                  >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Contact on WhatsApp
                  </a>
                ) : (
                  <span className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-5 py-3 text-sm text-zinc-500">
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Broker contact coming soon
                  </span>
                )}
                {/* Phone is resolved server-side via /api/contact-broker/{id} (DPDP-safe:
                    raw digits are never rendered into public HTML). */}
                {card.waLink && (
                  <a
                    href={card.waLink}
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-5 py-3 text-sm font-medium text-zinc-200 transition-colors hover:border-green-400/40 hover:text-white"
                  >
                    <Phone className="h-4 w-4" aria-hidden="true" />
                    Show phone number
                  </a>
                )}
              </div>

              <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
                Listing sourced from verified broker WhatsApp networks and refreshed continuously by
                PropAI.
              </p>
            </div>
          </aside>
        </div>

        <p className="mt-6 text-xs text-zinc-600">
          This listing is sourced from live broker activity in PropAI&apos;s WhatsApp network. Details
          are parsed automatically and may change — confirm specifics with the broker before proceeding.
        </p>

        {/* Internal links: same locality views, same BHK, same building. */}
        {card.localitySlug && (
          <nav className="mt-8" aria-label="Related searches">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
              More like this
            </h2>
            <div className="flex flex-wrap gap-2.5">
              {(() => {
                const txn = (listing.intent || "").toLowerCase().includes("rent") ? "rent" : "sale";
                const links: Array<{ href: string; label: string }> = [
                  { href: `/localities/${card.localitySlug}/${txn}`, label: `${card.locality} ${txn === "rent" ? "for Rent" : "for Sale"}` },
                ];
                const bhkNum = (listing.bhk || "").match(/(\d+)/)?.[1];
                if (bhkNum) {
                  links.push({ href: `/localities/${card.localitySlug}/bhk-${bhkNum}`, label: `${bhkNum} BHK in ${card.locality}` });
                }
                if (listing.building_name) {
                  links.push({ href: `/buildings/${slugify(listing.building_name)}`, label: `${listing.building_name}` });
                }
                return links.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    className="rounded-lg border border-white/10 bg-zinc-900/60 px-3.5 py-2 text-sm text-zinc-200 transition-colors hover:border-green-400/40 hover:text-white"
                  >
                    {l.label}
                  </Link>
                ));
              })()}
            </div>
          </nav>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
