import { getServerSupabase, slugify } from "./supabase";
import { canonicalLocality } from "./locality-canon";
import { formatBhkList, getLocalityData, type BuildingDetail, type BuildingListing } from "./localities";

// ── Types ─────────────────────────────────────────────────────────

export type RelatedLink = { label: string; href: string };

export type BuildingSection = {
  heading: string;
  links: RelatedLink[];
};

export type BuildingHeroStats = {
  listingCount: number;
  avgRent: string | null;
  avgSalePrice: string | null;
  lastUpdated: string | null;
  bhkRange: string | null;
  avgPricePerSqft: string | null;
};

export type SimilarBuilding = {
  name: string;
  slug: string;
  microMarket: string | null;
  listingCount: number;
  avgPrice: number | null;
  priceUnit: string | null;
};

// ── Helpers ───────────────────────────────────────────────────────

function intentSlug(intent: string | null): string {
  if (!intent) return "";
  const i = intent.toLowerCase();
  if (i === "rent" || i === "rental" || i === "lease") return "rent";
  if (i === "sell" || i === "sale" || i === "buy") return "sale";
  return "";
}

function parseBhk(bhk: string | null): number | null {
  if (!bhk) return null;
  const m = bhk.match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

function priceToINR(price: number, unit: string | null): number {
  const u = (unit || "").toLowerCase();
  if (u.includes("cr") || u.includes("crore")) return price * 1_00_00_000;
  if (u.includes("lac") || u.includes("lakh")) return price * 1_00_000;
  if (u.includes("k")) return price * 1_000;
  return price;
}

function formatINR(val: number): string {
  if (val >= 1_00_00_000) return `₹${(val / 1_00_00_000).toFixed(1).replace(/\.0$/, "")} Cr`;
  if (val >= 1_00_000) return `₹${(val / 1_00_000).toFixed(1).replace(/\.0$/, "")} Lakh`;
  if (val >= 1_000) return `₹${(val / 1_000).toFixed(0)}K`;
  return `₹${val.toLocaleString("en-IN")}`;
}

// ── Hero Stats ────────────────────────────────────────────────────

export function computeHeroStats(listings: BuildingListing[]): BuildingHeroStats {
  if (listings.length === 0) {
    return {
      listingCount: 0,
      avgRent: null,
      avgSalePrice: null,
      lastUpdated: null,
      bhkRange: null,
      avgPricePerSqft: null,
    };
  }

  const rentListings = listings.filter((l) => intentSlug(l.intent) === "rent" && l.price);
  const saleListings = listings.filter((l) => intentSlug(l.intent) === "sale" && l.price);

  const avgRent =
    rentListings.length > 0
      ? formatINR(
          rentListings.reduce((s, l) => s + priceToINR(l.price!, l.price_unit), 0) /
            rentListings.length,
        ) + "/month"
      : null;

  const avgSalePrice =
    saleListings.length > 0
      ? formatINR(
          saleListings.reduce((s, l) => s + priceToINR(l.price!, l.price_unit), 0) /
            saleListings.length,
        )
      : null;

  const bhkSet = new Set<string>();
  for (const l of listings) {
    const b = parseBhk(l.bhk);
    if (b && b >= 1 && b <= 10) bhkSet.add(`${b} BHK`);
  }
  const bhkRange = formatBhkList(Array.from(bhkSet));

  const pricesPerSqft = listings
    .map((l) => l.price_per_sqft)
    .filter((p): p is number => typeof p === "number" && p > 0);
  const avgPricePerSqft =
    pricesPerSqft.length > 0
      ? `₹${Math.round(pricesPerSqft.reduce((s, p) => s + p, 0) / pricesPerSqft.length).toLocaleString("en-IN")}/sqft`
      : null;

  let lastUpdated: string | null = null;
  let latestMs = 0;
  for (const l of listings) {
    if (l.last_seen) {
      const ms = new Date(l.last_seen).getTime();
      if (ms > latestMs) {
        latestMs = ms;
        lastUpdated = l.last_seen;
      }
    }
  }

  return {
    listingCount: listings.length,
    avgRent,
    avgSalePrice,
    lastUpdated,
    bhkRange,
    avgPricePerSqft,
  };
}

// ── About the Building ────────────────────────────────────────────

export function generateBuildingSummary(
  building: BuildingDetail,
  listings: BuildingListing[],
  stats: BuildingHeroStats,
): string {
  const name = building.name;
  const locality = building.microMarket || "this locality";
  const count = listings.length;
  const locationSentence = building.address
    ? `${name} is at ${building.address}.`
    : `${name} is a building in ${locality}.`;
  if (count === 0) {
    return `${locationSentence} There are no fresh broker listings matched to this building right now. New matching listings will appear here automatically from the WhatsApp network.`;
  }
  const parts: string[] = [
    locationSentence,
    `This page shows ${count} fresh broker listing${count === 1 ? "" : "s"} matched to this building and locality.`,
    "Listings come from live WhatsApp broker conversations and may change as new messages arrive.",
  ];
  return parts.join(" ");
}

// ── Similar Buildings Nearby ──────────────────────────────────────

export async function getSimilarBuildings(
  buildingName: string,
  microMarket: string | null,
): Promise<SimilarBuilding[]> {
  const db = getServerSupabase();
  if (!db || !microMarket) return [];

  const canon = canonicalLocality(microMarket);
  if (!canon.slug) return [];

  const { data, error } = await db.rpc("get_similar_buildings", {
    p_slug: canon.slug,
    p_building_name: buildingName,
  });
  if (error || !Array.isArray(data)) {
    if (error) console.error("getSimilarBuildings RPC error:", error.message);
    return [];
  }

  return data.map((row: {
    name: string;
    listing_count: number;
    avg_price: number | null;
    price_unit: string | null;
  }) => ({
    name: row.name,
    slug: slugify(row.name),
    microMarket,
    listingCount: Number(row.listing_count),
    avgPrice: row.avg_price == null ? null : Number(row.avg_price),
    priceUnit: row.price_unit,
  }));
}

// ── More Properties in Locality ───────────────────────────────────

export async function getLocalityListingCount(microMarket: string | null): Promise<number> {
  if (!microMarket) return 0;
  const data = await getLocalityData(microMarket);
  return data?.totalListings ?? 0;
}

// ── Nearby Localities ─────────────────────────────────────────────

const ADJACENCY: Record<string, string[]> = {
  "bandra west": ["khar west", "santacruz west", "bandra east", "juhu"],
  "bandra east": ["bandra west", "santacruz east"],
  "khar west": ["bandra west", "santacruz west", "andheri west"],
  "santacruz west": ["bandra west", "khar west", "andheri west"],
  "santacruz east": ["santacruz west", "bandra east"],
  "andheri west": ["khar west", "santacruz west", "juhu", "goregaon west"],
  "andheri east": ["andheri west", "santacruz east", "goregaon east"],
  "goregaon west": ["andheri west", "malad west"],
  "goregaon east": ["andheri east", "malad east"],
  "malad west": ["goregaon west", "kandivali west"],
  "malad east": ["goregaon east", "kandivali east"],
  "juhu": ["andheri west", "bandra west", "santacruz west"],
  "powai": ["vikhroli", "ghatkopar east"],
  "lower parel": ["worli", "parel", "mahim"],
  "worli": ["lower parel", "parel", "mahalaxmi"],
  "parel": ["lower parel", "worli", "lalbaug"],
  "dadar west": ["matunga", "mahim", "parel"],
  "dadar east": ["matunga", "sion", "wadala"],
  "thane west": ["ghodbunder road"],
};

export function getNearbyLocalities(microMarket: string | null): RelatedLink[] {
  if (!microMarket) return [];
  const key = microMarket.trim().toLowerCase();
  const adj = ADJACENCY[key] || [];
  return adj.map((loc) => {
    const canon = canonicalLocality(loc);
    return {
      label: canon.label || loc,
      href: `/localities/${canon.slug || slugify(loc)}`,
    };
  });
}

// ── Nearby Landmarks ──────────────────────────────────────────────

export async function getNearbyLandmarks(microMarket: string | null): Promise<RelatedLink[]> {
  const db = getServerSupabase();
  if (!db || !microMarket) return [];

  const canon = canonicalLocality(microMarket);
  if (!canon.slug) return [];

  const { data } = await db
    .from("locality_reference")
    .select("landmarks, sub_locality")
    .eq("parent_locality", canon.label)
    .limit(20);

  if (!data || data.length === 0) return [];

  const landmarks = new Set<string>();
  for (const row of data) {
    if (Array.isArray(row.landmarks)) {
      for (const lm of row.landmarks) {
        if (lm && typeof lm === "string") landmarks.add(lm);
      }
    }
    if (row.sub_locality) landmarks.add(row.sub_locality);
  }

  return Array.from(landmarks)
    .slice(0, 8)
    .map((lm) => ({
      label: lm,
      href: `/localities/${canon.slug}?near=${encodeURIComponent(lm)}`,
    }));
}

// ── Popular Searches ──────────────────────────────────────────────

export function getPopularSearches(
  microMarket: string | null,
  bhkRange: string | null,
): RelatedLink[] {
  const locality = microMarket || "Mumbai";
  const localitySlug = canonicalLocality(microMarket).slug || slugify(microMarket || "mumbai");

  const searches: RelatedLink[] = [
    { label: `Properties in ${locality}`, href: `/localities/${localitySlug}` },
    { label: `${locality} for Rent`, href: `/localities/${localitySlug}/rent` },
    { label: `${locality} for Sale`, href: `/localities/${localitySlug}/sale` },
  ];

  // Add BHK-specific searches based on what's available
  if (bhkRange) {
    const bhks = bhkRange.match(/\d+/g) || [];
    for (const b of bhks.slice(0, 3)) {
      searches.push({
        label: `${b} BHK in ${locality}`,
        href: `/localities/${localitySlug}/${b}-bhk`,
      });
    }
  }

  searches.push(
    { label: "Luxury Apartments", href: `/localities/${localitySlug}?sort=price_desc` },
    { label: "Recently Added", href: `/localities/${localitySlug}?sort=recent` },
  );

  return searches;
}

// ── Market Insights ───────────────────────────────────────────────

export type MarketInsight = { label: string; value: string };

export function computeMarketInsights(
  listings: BuildingListing[],
): MarketInsight[] {
  if (listings.length === 0) return [];

  const insights: MarketInsight[] = [];

  insights.push({ label: "Total Listings", value: listings.length.toLocaleString("en-IN") });

  const rentCount = listings.filter((l) => intentSlug(l.intent) === "rent").length;
  const saleCount = listings.filter((l) => intentSlug(l.intent) === "sale").length;
  if (rentCount > 0) insights.push({ label: "Rental Listings", value: rentCount.toLocaleString("en-IN") });
  if (saleCount > 0) insights.push({ label: "Sale Listings", value: saleCount.toLocaleString("en-IN") });

  // Average rent
  const rentPrices = listings
    .filter((l) => intentSlug(l.intent) === "rent" && l.price)
    .map((l) => priceToINR(l.price!, l.price_unit));
  if (rentPrices.length > 0) {
    const avg = rentPrices.reduce((s, p) => s + p, 0) / rentPrices.length;
    insights.push({ label: "Avg Rent", value: formatINR(avg) + "/month" });
  }

  // Average sale price
  const salePrices = listings
    .filter((l) => intentSlug(l.intent) === "sale" && l.price)
    .map((l) => priceToINR(l.price!, l.price_unit));
  if (salePrices.length > 0) {
    const avg = salePrices.reduce((s, p) => s + p, 0) / salePrices.length;
    insights.push({ label: "Avg Sale Price", value: formatINR(avg) });
  }

  // Most common BHK
  const bhkCounts = new Map<string, number>();
  for (const l of listings) {
    if (l.bhk) bhkCounts.set(l.bhk, (bhkCounts.get(l.bhk) || 0) + 1);
  }
  if (bhkCounts.size > 0) {
    const top = Array.from(bhkCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    insights.push({ label: "Most Common BHK", value: top[0] });
  }

  // Average price per sqft
  const ppsf = listings
    .map((l) => l.price_per_sqft)
    .filter((p): p is number => typeof p === "number" && p > 0);
  if (ppsf.length > 0) {
    const avg = Math.round(ppsf.reduce((s, p) => s + p, 0) / ppsf.length);
    insights.push({ label: "Avg Price/sqft", value: `₹${avg.toLocaleString("en-IN")}` });
  }

  // Recently added (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = listings.filter((l) => {
    if (!l.last_seen) return false;
    return new Date(l.last_seen).getTime() > sevenDaysAgo;
  });
  if (recent.length > 0) {
    insights.push({ label: "Added This Week", value: recent.length.toLocaleString("en-IN") });
  }

  // Unique brokers
  const brokers = new Set(listings.map((l) => l.broker_name).filter(Boolean));
  if (brokers.size > 0) {
    insights.push({ label: "Active Brokers", value: brokers.size.toLocaleString("en-IN") });
  }

  return insights;
}

// ── Nearby Buildings ("People also viewed") ───────────────────────

export async function getNearbyBuildings(
  buildingName: string,
  microMarket: string | null,
): Promise<SimilarBuilding[]> {
  // Reuse similar buildings logic — same concept, different heading
  return getSimilarBuildings(buildingName, microMarket);
}

// ── Breadcrumb ────────────────────────────────────────────────────

export function buildBuildingBreadcrumb(
  siteUrl: string,
  buildingName: string,
  microMarket: string | null,
) {
  const trail: Array<{ name: string; url: string }> = [
    { name: "Home", url: "/" },
    { name: "Mumbai", url: "/localities" },
  ];

  if (microMarket) {
    const canon = canonicalLocality(microMarket);
    if (canon.slug) {
      trail.push({ name: canon.label, url: `/localities/${canon.slug}` });
    }
  }

  trail.push({ name: buildingName, url: "" });

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.name,
      item: t.url ? `${siteUrl}${t.url}` : undefined,
    })),
  };
}
