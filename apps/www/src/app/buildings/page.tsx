import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getAllBuildings, type BuildingOnMap } from "@/lib/localities";
import ListingCard from "@/components/ListingCard";
import SiteHeader from "@/components/SiteHeader";

export const metadata = {
  title: "Buildings — PropAI",
  description:
    "Browse buildings tracked by PropAI, with listing counts from WhatsApp broker networks.",
};

export default async function BuildingsIndexPage() {
  const buildings = await getAllBuildings();

  const cards: BuildingOnMap[] = buildings.map((b) => ({
    name: b.name,
    id: b.id,
    latitude: null,
    longitude: null,
    listingCount: b.listingCount,
    minPrice: null,
    maxPrice: null,
    bhkRange: null,
    address: b.address,
    developer: b.developer,
  }));

  return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <header className="mb-10">
          <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-3">
            Buildings
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl">
            {buildings.length} buildings tracked by PropAI, with live listing
            counts from broker conversations.
          </p>
        </header>

        {buildings.length === 0 ? (
          <p className="text-zinc-400">No buildings indexed yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
            {cards.map((b) => (
              <ListingCard key={b.name} building={b} />
            ))}
          </div>
        )}

        <div className="text-center mt-12">
          <Link
            href="/localities"
            className="inline-flex items-center gap-2 px-6 py-3 bg-green-400 text-black text-sm font-semibold rounded-lg hover:bg-green-300 transition-colors"
          >
            Browse by locality
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </main>
    </div>
  );
}
