export const revalidate = 300;
export const dynamic = "force-dynamic";

import PublicMarketplaceHome from "@/components/PublicMarketplaceHome";
import { getPublicDataOverview, getPublicListingPhotos, type PublicDataOverview } from "@/lib/public-data";
import { getAllBuildings, getAllLocalities, type BuildingSummary, type LocalitySummary } from "@/lib/localities";

function withTimeout<T>(promise: Promise<T>, timeoutMs = 30000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Homepage data query timed out")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

const emptyOverview: PublicDataOverview = {
  counts: { localities: 0, buildings: 0, listings: 0, activeListings: 0, brokers: 0, raw_messages: 0, messagesAnalysed: 0 },
  countsAvailable: false, activity: [], topLocalities: [], topBuildings: [], recentListings: [],
};

export default async function WWWPage() {
  let overview = emptyOverview;
  let buildings: BuildingSummary[] = [];
  let localities: LocalitySummary[] = [];
  let heroImageUrl: string | null = null;
  // Keep the listing feed independent from the locality directory. Locality
  // aggregation fans out into multiple database reads and can be slow during
  // a busy ingest cycle; it must not turn a healthy live inventory query into
  // the homepage empty state.
  const [overviewResult, localitiesResult, buildingsResult] = await Promise.allSettled([
      withTimeout(getPublicDataOverview({ skipBuildingScan: true, skipCounts: false, skipLocalities: true, skipActivity: true })),
      withTimeout(getAllLocalities(), 12000),
      withTimeout(getAllBuildings(), 8000),
  ]);
  if (overviewResult.status === "fulfilled") {
    overview = overviewResult.value;
    const firstListingId = overview.recentListings.find((listing) => (listing.photo_count ?? 0) > 0)?.id
      ?? overview.recentListings[0]?.id;
    if (firstListingId) {
      try {
        const photos = await withTimeout(getPublicListingPhotos(firstListingId), 5000);
        heroImageUrl = photos[0]?.url ?? null;
      } catch (error) {
        console.error("Homepage hero photo query failed:", error);
      }
    }
  } else {
    console.error("Homepage overview query failed:", overviewResult.reason);
  }
  if (localitiesResult.status === "fulfilled") {
    localities = localitiesResult.value;
    overview = { ...overview, topLocalities: localities };
  } else {
    console.error("Homepage locality lookup failed:", localitiesResult.reason);
  }
  if (buildingsResult.status === "fulfilled") {
    buildings = buildingsResult.value;
  } else {
    console.error("Homepage building lookup failed:", buildingsResult.reason);
  }
  return <PublicMarketplaceHome overview={overview} heroImageUrl={heroImageUrl} buildings={buildings} />;
}
