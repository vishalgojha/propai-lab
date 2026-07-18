import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, MapPin, MessageSquare, ShieldCheck } from "lucide-react";
import {
  getBuildingBySlug,
  getBuildingListings,
  type BuildingListing,
} from "@/lib/localities";
import { toListingCardViewModel, type ListingCardFields } from "@/lib/listing-card";
import { slugify } from "@/lib/supabase";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import ListingTile from "@/components/ListingTile";

type Params = { params: Promise<{ slug: string }> };

// ISR: cache the rendered building page for 5 min. Inventory updates
// gradually, so a few minutes of staleness is fine and avoids re-querying
// Supabase on every request.
export const revalidate = 300;

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const building = await getBuildingBySlug(slug);
  if (!building) return { title: "Building not found — PropAI" };
  const locality = building.microMarket ? ` in ${building.microMarket}` : "";
  return {
    title: `${building.name}${locality} — Buildings | PropAI`,
    description: `Live listings, price ranges, and broker activity for ${building.name}${locality}, sourced from WhatsApp broker conversations.`,
  };
}

function toCardFields(row: BuildingListing): ListingCardFields {
  return {
    id: row.id,
    bhk: row.bhk,
    price: row.price,
    price_unit: row.price_unit,
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

export default async function BuildingPage({ params }: Params) {
  const { slug } = await params;
  const building = await getBuildingBySlug(slug);
  if (!building) notFound();

  const listings = await getBuildingListings(building.name);

  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <div className="mb-8">
          <Link
            href="/buildings"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors"
          >
            <span aria-hidden="true">←</span> All buildings
          </Link>
        </div>

        <header className="mb-10">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-3">
                {building.name}
              </h1>
              {building.microMarket && (
                <Link
                  href={`/localities/${slugify(building.microMarket)}`}
                  className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-green-400/30 hover:text-green-200 transition-colors"
                >
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  {building.microMarket}
                </Link>
              )}
            </div>
            {building.enrichmentConfidence != null && building.enrichmentConfidence >= 0.7 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-xs font-medium text-green-300">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                Verified
              </span>
            )}
          </div>

          {building.address && (
            <p className="mt-4 text-[15px] lg:text-[17px] text-zinc-400 max-w-2xl">{building.address}</p>
          )}
          {building.developer && (
            <p className="mt-1 text-sm text-zinc-500">Developer: {building.developer}</p>
          )}
        </header>

        <section>
          <h2 className="text-xl font-semibold text-white mb-6">
            {listings.length > 0
              ? `${listings.length} listing${listings.length === 1 ? "" : "s"}`
              : "No active listings yet"}
          </h2>

          {listings.length === 0 ? (
            <p className="text-zinc-400">
              No broker activity has been tracked for {building.name} yet. Listings appear
              automatically as soon as brokers post in our WhatsApp network.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 lg:gap-6">
              {listings.map((row) => {
                const card = toListingCardViewModel(toCardFields(row), false, building.microMarket);
                return <ListingTile key={row.id} card={card} buildingName={building.name} />;
              })}
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
