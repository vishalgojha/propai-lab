import { MapPinned, RefreshCw } from "lucide-react";
import { getPublicMapListings } from "@/lib/natural-search";
import { getAllBuildings, getAllLocalities } from "@/lib/localities";
import { toListingCardViewModel } from "@/lib/listing-card";
import SearchBox from "@/components/SearchBox";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ListingTile from "@/components/ListingTile";
import SearchMapLoader from "@/components/SearchMapLoader";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";

const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  null;

export const revalidate = 300;
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Property Map — Live Listings | PropAI",
  description:
    "Explore fresh property listings on a map, with live broker inventory alongside every mapped result.",
};

// Keep the map responsive: it renders every returned card beside the map and
// enriches building coordinates in batches. The feed is intentionally the
// most recent slice, not a claim that this is the whole inventory.
const MAP_RESULT_LIMIT = 60;

export default async function MapPage() {
  const [results, localitiesResult, buildingsResult] = await Promise.all([
    getPublicMapListings(MAP_RESULT_LIMIT),
    getAllLocalities().then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error })),
    getAllBuildings().then((value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error })),
  ]);
  const localities = localitiesResult.ok ? localitiesResult.value : [];
  const buildings = buildingsResult.ok ? buildingsResult.value : [];
  if (!localitiesResult.ok) console.error("Map locality autocomplete query failed:", localitiesResult.error);
  if (!buildingsResult.ok) console.error("Map building autocomplete query failed:", buildingsResult.error);
  const mappedResults = results.filter(
    (result) => result.latitude != null && result.longitude != null,
  );

  return (
    <div className="www-shell min-h-screen text-white">
      <SiteHeader />
      <ShortlistProvider>
      <main className="www-page-main www-map-page mx-auto max-w-[1800px] px-4 sm:px-8 xl:px-12 py-8 lg:py-10">
          <header className="mb-8 max-w-3xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-xs font-medium text-green-300">
              <MapPinned className="h-3.5 w-3.5" aria-hidden="true" />
              Live map view
            </div>
            <h1 className="www-map-title mt-4 text-[32px] lg:text-[48px] leading-[1.05] font-bold text-white">
              Find properties by location
            </h1>
            <p className="mt-4 text-[15px] lg:text-[18px] text-zinc-400">
              Showing the {results.length.toLocaleString("en-IN")} most recent listings from
              the WhatsApp broker network, with {mappedResults.length.toLocaleString("en-IN")} plotted on the map.
            </p>
            <div className="mt-6 max-w-3xl">
              <SearchBox query="" asset="" localities={localities} buildings={buildings} />
            </div>
          </header>

          {results.length === 0 ? (
            <div className="rounded-2xl border border-white/10 bg-zinc-950/80 p-10 text-center">
              <RefreshCw className="mx-auto h-6 w-6 text-green-400" aria-hidden="true" />
              <h2 className="mt-4 text-lg font-semibold text-white">No live listings to map right now</h2>
              <p className="mt-2 text-sm text-zinc-400">
                New broker posts appear here automatically as they arrive.
              </p>
            </div>
          ) : mappedResults.length === 0 ? (
            <>
              <div className="www-map-no-coordinates mb-6 flex items-start gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--accent-soft)] px-5 py-4">
                <MapPinned className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-forest)]" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">Location verification is in progress</p>
                  <p className="mt-1 text-sm text-[var(--text-secondary)]">These listings are live and browseable below. The map will fill in as building locations are verified.</p>
                </div>
              </div>
              <section aria-label="Live property listings" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {results.map((row) => (
                  <ListingTile key={row.id} card={toListingCardViewModel(row, false)} buildingName={row.building_name} footerNote="Live inventory" />
                ))}
              </section>
            </>
          ) : (
            <div className="grid gap-6 lg:grid-cols-[minmax(360px,0.9fr)_minmax(0,1.35fr)] lg:items-start">
              <section
                aria-label="Mapped live listings"
                className="order-2 grid max-h-[calc(100vh-170px)] grid-cols-1 gap-4 overflow-y-auto pr-1 sm:grid-cols-2 lg:order-1 lg:grid-cols-1"
              >
                {results.map((row) => (
                  <ListingTile
                    key={row.id}
                    card={toListingCardViewModel(row, false)}
                    buildingName={row.building_name}
                    footerNote="Live inventory"
                  />
                ))}
              </section>

              <section
                aria-label="Mumbai property map"
                className="order-1 lg:order-2 lg:sticky lg:top-24"
              >
                <SearchMapLoader results={results} apiKey={GOOGLE_MAPS_API_KEY} />
              </section>
            </div>
          )}
        </main>
      </ShortlistProvider>
      <SiteFooter />
    </div>
  );
}
