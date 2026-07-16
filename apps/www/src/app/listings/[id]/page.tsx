import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapPin, MessageSquare, ShieldCheck, Clock } from "lucide-react";
import { getListingById } from "@/lib/localities";
import { toListingCardViewModel, type ListingCardFields } from "@/lib/listing-card";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ListingSpecs from "@/components/ListingSpecs";

type Params = { params: Promise<{ id: string }> };

function toCardFields(row: NonNullable<Awaited<ReturnType<typeof getListingById>>>): ListingCardFields {
  return {
    id: row.id,
    bhk: row.bhk,
    price: row.price,
    price_unit: row.price_unit,
    area_sqft: row.area_sqft,
    furnishing: row.furnishing,
    intent: row.intent,
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
  const listing = await getListingById(Number(id));
  if (!listing) return { title: "Listing not found — PropAI" };
  const card = toListingCardViewModel(toCardFields(listing), false);
  const locality = card.locality ? ` in ${card.locality}` : "";
  return {
    title: `${card.title}${locality} — ${card.priceLabel} | PropAI`,
    description: `${card.title}${locality}. ${card.specRow}. Sourced from live WhatsApp broker activity on PropAI.`,
  };
}

export default async function ListingPage({ params }: Params) {
  const { id } = await params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) notFound();

  const listing = await getListingById(numericId);
  if (!listing) notFound();

  const card = toListingCardViewModel(toCardFields(listing), false);

  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="max-w-4xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <div className="mb-8 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
          {listing.buildingSlug ? (
            <Link href={`/buildings/${listing.buildingSlug}`} className="hover:text-white transition-colors">
              {listing.building_name}
            </Link>
          ) : (
            <Link href="/search" className="hover:text-white transition-colors">
              ← All listings
            </Link>
          )}
          {listing.localitySlug && (
            <>
              <span aria-hidden="true">/</span>
              <Link href={`/localities/${listing.localitySlug}`} className="hover:text-white transition-colors">
                {listing.micro_market}
              </Link>
            </>
          )}
        </div>

        <div className="rounded-3xl border border-white/10 bg-zinc-950/90 p-6 lg:p-10">
          <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
            <h1 className="text-[28px] lg:text-[38px] leading-[1.1] font-bold text-white max-w-2xl">
              {card.title}
            </h1>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                card.statusTone === "available"
                  ? "border border-green-400/20 bg-green-400/10 text-green-300"
                  : "border border-amber-400/20 bg-amber-400/10 text-amber-200"
              }`}
            >
              {card.statusLabel}
            </span>
          </div>

          {card.locality && (
            <Link
              href={`/localities/${card.localitySlug}`}
              className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-green-400/30 hover:text-green-200 transition-colors mb-6"
            >
              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
              {card.locality}
            </Link>
          )}

          <div className="mb-6">
            <span className="text-3xl lg:text-4xl font-semibold text-white">{card.priceLabel}</span>
          </div>

          {card.specItems.length > 0 && (
            <ListingSpecs items={card.specItems} className="mb-8 text-base" />
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <div className="rounded-2xl border border-white/10 bg-black/60 p-5">
              <div className="flex items-center gap-2 text-sm text-zinc-500 mb-2">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Broker
              </div>
              <p className="text-white font-medium break-words">{card.brokerName || "Verified network"}</p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/60 p-5">
              <div className="flex items-center gap-2 text-sm text-zinc-500 mb-2">
                <Clock className="h-4 w-4" aria-hidden="true" />
                Last updated
              </div>
              <p className="text-white font-medium">{card.updatedLabel}</p>
            </div>
          </div>

          {listing.location_label && (
            <p className="text-sm text-zinc-400 mb-8">{listing.location_label}</p>
          )}

          <div className="flex flex-wrap gap-3">
            {card.waLink ? (
              <a
                href={card.waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-green-400 px-6 py-3 text-sm font-semibold text-black transition-colors hover:bg-green-300"
              >
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                Contact Broker on WhatsApp
              </a>
            ) : (
              <span className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-6 py-3 text-sm text-zinc-500">
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
                Broker contact coming soon
              </span>
            )}
            {listing.buildingSlug && (
              <Link
                href={`/buildings/${listing.buildingSlug}`}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-6 py-3 text-sm font-medium text-zinc-200 hover:border-green-400/40 hover:text-white transition-colors"
              >
                See other listings in {listing.building_name}
              </Link>
            )}
          </div>
        </div>

        <p className="mt-6 text-xs text-zinc-600">
          This listing is sourced from live broker activity in PropAI&apos;s WhatsApp network. Details
          are parsed automatically and may change — confirm specifics with the broker before proceeding.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
