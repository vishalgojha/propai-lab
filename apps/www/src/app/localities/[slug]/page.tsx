import { notFound } from "next/navigation";
import { MapPin, Building2 } from "lucide-react";
import Link from "next/link";
import { getLocalityData, getAllLocalities } from "@/lib/localities";
import LocalityMapLoader from "@/components/LocalityMapLoader";
import ListingCard, { LocalityBackLink } from "@/components/ListingCard";
import { NoPhotosFaqJsonLd, NoPhotosFaq } from "@/components/NoPhotosFaq";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const data = await getLocalityData(slug);
  if (!data) return { title: "Locality not found — PropAI" };
  return {
    title: `${data.locality} — Properties & Brokers | PropAI`,
    description: `Live ${data.locality} listings, price ranges, and broker activity sourced from WhatsApp broker conversations.`,
  };
}

export default async function LocalityPage({ params }: Params) {
  const { slug } = await params;
  const data = await getLocalityData(slug);
  if (!data) notFound();

  const mapped = data.buildings.filter(
    (b) => b.latitude != null && b.longitude != null,
  );

  // A known place with zero active listings — distinct from a typo/404 slug.
  if (!data.hasListings) {
    const suggestions = (await getAllLocalities()).slice(0, 5);
    return (
      <div className="min-h-screen bg-black text-white">
        <main className="max-w-3xl mx-auto px-4 lg:px-6 py-16 lg:py-24">
          <NoPhotosFaqJsonLd />
          <div className="mb-8">
            <LocalityBackLink />
          </div>
          <div className="bg-zinc-900/50 border border-white/10 rounded-2xl p-8 lg:p-10 text-center">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-zinc-800 mb-5 mx-auto">
              <Building2 className="w-6 h-6 text-green-400" aria-hidden="true" />
            </div>
            <h1 className="text-[28px] lg:text-[36px] leading-[1.1] font-bold text-white mb-3">
              No listings in {data.locality} yet
            </h1>
            <p className="text-lg text-zinc-400 max-w-xl mx-auto">
              {data.locality} is on our radar, but no broker activity has been
              tracked there yet. Listings appear automatically as soon as brokers
              start posting in our WhatsApp network.
            </p>
            {suggestions.length > 0 && (
              <div className="mt-8">
                <p className="text-sm text-zinc-500 mb-4">
                  Browse a locality with live listings:
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  {suggestions.map((loc) => (
                    <Link
                      key={loc.slug}
                      href={`/localities/${loc.slug}`}
                      className="px-4 py-2 rounded-lg bg-zinc-800 border border-white/10 text-white text-sm font-medium hover:border-green-400/50 transition-colors"
                    >
                      {loc.locality}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
          <NoPhotosFaq />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white">
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <NoPhotosFaqJsonLd />
        <div className="mb-8">
          <LocalityBackLink />
        </div>

        <header className="mb-8">
          <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-3">
            {data.locality}
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl">
            {data.totalListings} active listing{data.totalListings === 1 ? "" : "s"} across{" "}
            {data.buildings.length} building{data.buildings.length === 1 ? "" : "s"},
            sourced from live WhatsApp broker conversations.
          </p>
          {mapped.length === 0 && (
            <p className="mt-3 inline-flex items-center gap-2 text-sm text-zinc-500">
              <MapPin className="w-4 h-4" aria-hidden="true" />
              Map view unavailable — location data still being enriched for this
              locality. Showing listing cards below.
            </p>
          )}
        </header>

        {mapped.length > 0 && (
          <section className="mb-12" aria-label={`Map of ${data.locality}`}>
            <LocalityMapLoader locality={data.locality} buildings={data.buildings} />
            {data.unmappedCount > 0 && (
              <p className="mt-3 text-xs text-zinc-500 text-center">
                Showing {mapped.length} of {data.buildings.length} buildings on the map.
                {data.unmappedCount} more are listed below.
              </p>
            )}
          </section>
        )}

        <section aria-label="Buildings in this locality">
          <h2 className="text-[20px] lg:text-[24px] font-semibold text-white mb-6">
            Buildings
          </h2>
          {data.buildings.length === 0 ? (
            <p className="text-zinc-400">No buildings with listings yet for this locality.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
              {data.buildings.map((b) => (
                <ListingCard key={b.name} building={b} />
              ))}
            </div>
          )}
        </section>

        <NoPhotosFaq />
      </main>
    </div>
  );
}
