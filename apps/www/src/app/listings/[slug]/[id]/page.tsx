import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
  ChevronRight,
  Tag,
} from "lucide-react";
import { getListingById, getBrokerAreas } from "@/lib/localities";
import { slugify } from "@/lib/supabase";
import {
  toListingCardViewModel,
  buildListingSlug,
  type ListingCardFields,
  type ListingSpecItem,
} from "@/lib/listing-card";
import { cleanBuildingName } from "@/lib/localities";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ListingSpecs from "@/components/ListingSpecs";
import BackButton from "@/components/BackButton";

type Params = { params: Promise<{ slug: string; id: string }> };

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
    deal_tags: row.deal_tags,
    additional_charges: row.additional_charges,
  };
}

// Computes the canonical slug for a listing row (id + bhk + locality).
// Kept in this file (as well as in listing-card.ts) so the metadata + page
// functions agree on the URL Google should index.
function canonicalSlugFor(row: NonNullable<Awaited<ReturnType<typeof getListingById>>>): string | null {
  return buildListingSlug({
    id: row.id,
    bhk: row.bhk,
    micro_market: row.micro_market,
    building_name: row.building_name,
    property_type: row.property_type,
  });
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
  const { slug, id } = await params;
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

  // Fetch broker's operating areas from their listing history
  const brokerAreas = await getBrokerAreas(listing.broker_phone);

  // If the request slug doesn't match the canonical slug (e.g. external site
  // linked to an older slug after the listing was edited), 301 to the canonical
  // URL so Google consolidates ranking signals.
  const canonicalSlug = canonicalSlugFor(listing);
  if (canonicalSlug && slug !== canonicalSlug) {
    redirect(`/listings/${canonicalSlug}/${numericId}`, "replace");
  }

  let card;
  try {
    card = toListingCardViewModel(toCardFields(listing), false);
  } catch (err) {
    console.error("toListingCardViewModel failed:", err);
    notFound();
  }
  // Defensive: ensure all required fields exist on card
  if (!card || !card.title || !card.href) {
    console.error("Invalid card view model:", card);
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
  // Canonical URL mirrors the dynamic route: /listings/[slug]/[id].
  const listingUrl = `${siteUrl}/listings/${canonicalSlug ?? "listing"}/${numericId}`;
  const priceUnit = (listing.price_unit || "").toLowerCase();
  let priceINR: number | null = null;
  if (typeof listing.price === "number" && !Number.isNaN(listing.price)) {
    if (priceUnit.includes("cr")) priceINR = listing.price * 1_00_00_000;
    else if (priceUnit.includes("lac") || priceUnit.includes("lakh")) priceINR = listing.price * 1_00_000;
    else if (priceUnit.includes("k")) priceINR = listing.price * 1_000;
    else priceINR = listing.price;
  }
  const safeTitle = card.title || `${listing.bhk || ""} ${listing.property_type || "property"} in ${card.locality || "Mumbai"}`.trim();
  const safeLocality = card.locality || "Mumbai";
  const listingSchema = buildRealEstateListing({
    url: listingUrl,
    id: numericId,
    title: safeTitle,
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
    { name: card.title || `Listing ${numericId}`, url: `/listings/${canonicalSlug ?? "listing"}/${numericId}` },
  ]);

  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <JsonLd data={listingSchema} />
      <JsonLd data={breadcrumbSchema} />
      <main className="mx-auto max-w-5xl px-4 py-8 lg:px-6 lg:py-12">
        <BackButton />

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
          <span className="text-zinc-400">{cleanBuildingName(listing.building_name) || card.title}</span>
        </div>

        <div className="grid grid-cols-1 gap-7 lg:grid-cols-[1fr_300px]">
          {/* Main column */}
          <div>
            {/* Header — no image hero. The page is text-first; photos are
                not part of the public inventory yet. */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-1.5 text-sm text-zinc-400">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{card.locality}</span>
                </div>
                <h1 className="mt-1 text-[28px] font-bold leading-[1.15] text-white lg:text-[34px]">
                  {cleanBuildingName(listing.building_name) || card.title}
                </h1>
              </div>
              <div className="text-right">
                <div className="text-3xl font-semibold text-white lg:text-4xl">{card.priceLabel}</div>
                {/* Badges row: asset_type + status + deal-type, replacing the
                    badges that used to float in the (now removed) image hero. */}
                <div className="mt-1 flex flex-wrap justify-end gap-1.5">
                  {card.assetTypeLabel && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-zinc-100">
                      <KindIcon kind={card.assetTypeLabel} className="h-3 w-3" />
                      {card.assetTypeLabel}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      card.statusTone === "available"
                        ? "border-green-400/20 bg-green-400/10 text-green-300"
                        : "border-orange-400/20 bg-orange-400/10 text-orange-300"
                    }`}
                  >
                    {card.statusLabel}
                  </span>
                  <span className="inline-flex items-center rounded-md bg-green-400/10 px-2 py-0.5 text-xs font-semibold text-green-300">
                    {dealType}
                  </span>
                </div>
                {card.dealTags.length > 0 && (
                  <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                    {card.dealTags.map((t) => (
                      <span
                        key={t.tag}
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.tone}`}
                      >
                        {t.label}
                      </span>
                    ))}
                  </div>
                )}
                {card.additionalCharges.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-zinc-400">
                    {card.additionalCharges.map((c, i) => (
                      <li key={`${c.label}-${i}`} className="flex items-center justify-end gap-1.5">
                        <span className="text-zinc-500">{c.label}</span>
                        <span className="font-medium text-zinc-200">{c.amountLabel}</span>
                      </li>
                    ))}
                  </ul>
                )}
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

            {/* Description — only show if location_label adds info beyond micro_market */}
            {listing.location_label && listing.location_label !== listing.micro_market && (
              <div className="mt-7">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  About this listing
                </h2>
                <p className="text-sm leading-relaxed text-zinc-300 break-words">{listing.location_label}</p>
              </div>
            )}

            {/* Landmarks / nearby — only show if we have actual landmark info */}
            {listing.landmark_name && listing.landmark_name !== card.locality && (
              <div className="mt-7">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
                  Nearby
                </h2>
                <ul className="space-y-1.5">
                  <li className="flex items-center gap-2 text-sm text-zinc-300">
                    <Building2 className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                    {listing.landmark_name}
                  </li>
                </ul>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="relative">
            <div className="sticky top-6 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/90 p-5">
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
                <span className="truncate">{card.brokerName || "PropAI network"}</span>
                {card.brokerName && (
                  <ShieldCheck className="h-4 w-4 shrink-0 text-green-400" aria-hidden="true" />
                )}
              </div>
              <div className="mt-1 text-center text-xs text-zinc-500">
                Active listings on PropAI
              </div>

              <div className="mt-5 flex flex-col gap-2.5">
                {/* Contact CTA: only render the WhatsApp button when we know
                    broker_phone can resolve to a wa.me link server-side. If
                    the phone is missing/bad, show a clear "unavailable" message
                    instead of a button that would just silently 302 back to
                    this page. Phone number is NEVER embedded in public HTML
                    (DPDP Act 2023). */}
                {card.waAvailable ? (
                  <a
                    href={card.waLink ?? "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-green-400 px-5 py-3 text-sm font-semibold text-black transition-colors hover:bg-green-300"
                  >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Contact on WhatsApp
                  </a>
                ) : (
                  <span
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-5 py-3 text-sm text-zinc-500"
                    data-testid="broker-unavailable"
                  >
                    <MessageSquare className="h-4 w-4" aria-hidden="true" />
                    Contact info unavailable
                  </span>
                )}
              </div>

              {brokerAreas.length > 0 && (
                <div className="mt-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 mb-2">
                    Active in
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {brokerAreas.map((area) => (
                      <span
                        key={area}
                        className="rounded-full bg-white/5 border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400"
                      >
                        {area}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-4 text-[11px] leading-relaxed text-zinc-500">
                Listing sourced from active broker WhatsApp networks and refreshed continuously by
                PropAI.
              </p>
            </div>
          </aside>
        </div>

        <p className="mt-6 text-xs text-zinc-600">
          This listing is sourced from live broker activity in PropAI&apos;s WhatsApp network. Details
          are parsed automatically and may change — confirm specifics with the broker before proceeding.
        </p>
        <p className="mt-1 text-xs text-zinc-600">
          Last updated: {listing.last_seen ? (() => {
            const d = new Date(listing.last_seen);
            const ms = d.getTime();
            if (!Number.isFinite(ms)) return "recently";
            const diffMs = Date.now() - ms;
            const dayMs = 24 * 60 * 60 * 1000;
            if (diffMs < 0) return "just now";
            if (diffMs < dayMs) return "today";
            if (diffMs < 2 * dayMs) return "yesterday";
            if (diffMs < 7 * dayMs) return `${Math.floor(diffMs / dayMs)}d ago`;
            return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
          })() : "recently"}
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
                  const cleanName = cleanBuildingName(listing.building_name);
                  if (cleanName) {
                    links.push({ href: `/buildings/${slugify(cleanName)}`, label: cleanName });
                  }
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
