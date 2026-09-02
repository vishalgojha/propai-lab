export const revalidate = 300;
export const dynamic = "force-dynamic";

import PublicMarketplaceHome from "@/components/PublicMarketplaceHome";
import { getPublicDataOverview, type PublicDataOverview } from "@/lib/public-data";

function withTimeout<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
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
  try {
    overview = await withTimeout(getPublicDataOverview({ skipBuildingScan: true, skipCounts: false, skipLocalities: false, skipActivity: true }));
  } catch (error) {
    console.error("Homepage overview query failed:", error);
  }
  return <PublicMarketplaceHome overview={overview} />;
}
