import { getServerSupabase, slugify } from "./supabase";
import { canonicalLocality } from "./locality-canon";

export type RelatedLink = {
  label: string;
  href: string;
};

export type RelatedSection = {
  heading: string;
  links: RelatedLink[];
  viewMoreHref?: string;
};

type ParsedQuery = {
  locality: string | null;
  bhk: number | null;
  intent: string | null;
  minPrice: number | null;
  maxPrice: number | null;
  asset: string | null;
  matchedLocalities?: Array<{ locality: string; slug: string }>;
};

type ListingRow = {
  micro_market: string | null;
  building_name: string | null;
  bhk: string | null;
  intent: string | null;
  asset_type: string | null;
  property_type: string | null;
  price: number | null;
  price_unit: string | null;
};

function intentSlug(intent: string | null): string {
  if (!intent) return "";
  const i = intent.toLowerCase();
  if (i === "rent" || i === "rental") return "rent";
  if (i === "sell" || i === "sale") return "sale";
  return "";
}

// ── Adjacency: which localities are "nearby" ──────────────────────
// Derived from Mumbai geography — Western suburbs corridor.
// Falls back to top-by-listing-count if no adjacency match.
const ADJACENCY: Record<string, string[]> = {
  "bandra west": ["khar west", "santacruz west", "bandra east", "bandra kurla complex", "juhu"],
  "bandra east": ["bandra west", "bandra kurla complex", "khar west", "santacruz east"],
  "khar west": ["bandra west", "santacruz west", "andheri west"],
  "santacruz west": ["bandra west", "khar west", "andheri west", "santacruz east"],
  "santacruz east": ["santacruz west", "bandra east", "andheri east"],
  "andheri west": ["khar west", "santacruz west", "goregaon west", "juhu", "vile parle west"],
  "andheri east": ["andheri west", "santacruz east", "marol", "goregaon east"],
  "goregaon west": ["andheri west", "malad west", "juhu"],
  "goregaon east": ["andheri east", "malad east"],
  "malad west": ["goregaon west", "kandivali west"],
  "malad east": ["goregaon east", "kandivali east"],
  "juhu": ["andheri west", "bandra west", "santacruz west"],
  "powai": ["vikhroli", "andel east", "ghatkopar east"],
  "lower parel": ["worli", "parel", "mahim"],
  "worli": ["lower parel", "prabhadevi", "mahalaxmi"],
  "parel": ["lower parel", "prabhadevi", "lalbaug"],
  "dadar west": ["matunga", "mahim", "parel"],
  "dadar east": ["matunga", "sion", "wadala"],
  "thane west": ["ghodbunder road", "wagle estate"],
};

function getAdjacentLocalities(raw: string): string[] {
  const key = (raw || "").trim().toLowerCase();
  if (ADJACENCY[key]) return ADJACENCY[key];
  // Fallback: strip direction and try again
  const bare = key.replace(/\s*(east|west|north|south)\s*$/, "").trim();
  for (const [k, v] of Object.entries(ADJACENCY)) {
    if (k.startsWith(bare)) return v;
  }
  return [];
}

// ── Nearby Localities ─────────────────────────────────────────────

async function buildNearbyLocalities(
  locality: string,
  intent: string | null,
): Promise<RelatedSection | null> {
  const canon = canonicalLocality(locality);
  if (!canon.slug) return null;

  const adjacent = getAdjacentLocalities(locality);
  const db = getServerSupabase();
  if (!db || adjacent.length === 0) return null;

  const links: RelatedLink[] = [];
  for (const adj of adjacent) {
    const adjCanon = canonicalLocality(adj);
    if (!adjCanon.slug || !adjCanon.public || !adjCanon.standalonePage) continue;
    const intentPart = intentSlug(intent);
    const href = intentPart
      ? `/localities/${adjCanon.slug}/${intentPart}`
      : `/localities/${adjCanon.slug}`;
    links.push({ label: adjCanon.label, href });
    if (links.length >= 5) break;
  }

  if (links.length === 0) return null;
  return {
    heading: "Nearby Localities",
    links,
    viewMoreHref: `/localities/${canon.slug}`,
  };
}

// ── Budget Suggestions ────────────────────────────────────────────

function buildBudgetSuggestions(
  minPrice: number | null,
  maxPrice: number | null,
  intent: string | null,
  locality: string | null,
): RelatedSection | null {
  const isRent = intent?.toLowerCase() === "rent";
  // Typical budget brackets for Mumbai
  const brackets = isRent
    ? [
        { min: 20_000, max: 40_000, label: "₹20K – 40K/month" },
        { min: 40_000, max: 80_000, label: "₹40K – 80K/month" },
        { min: 80_000, max: 1_50_000, label: "₹80K – 1.5L/month" },
        { min: 1_50_000, max: 3_00_000, label: "₹1.5L – 3L/month" },
        { min: 3_00_000, max: 5_00_000, label: "₹3L – 5L/month" },
      ]
    : [
        { min: 50_00_000, max: 1_00_00_000, label: "₹50L – 1 Cr" },
        { min: 1_00_00_000, max: 2_00_00_000, label: "₹1 – 2 Cr" },
        { min: 2_00_00_000, max: 5_00_00_000, label: "₹2 – 5 Cr" },
        { min: 5_00_00_000, max: 10_00_00_000, label: "₹5 – 10 Cr" },
        { min: 10_00_00_000, max: 50_00_00_000, label: "₹10 – 50 Cr" },
      ];

  // If user has a budget, show brackets around it
  const targetINR = minPrice || maxPrice;
  let selected = brackets;
  if (targetINR) {
    const idx = brackets.findIndex((b) => targetINR >= b.min && targetINR <= b.max);
    if (idx >= 0) {
      // Show this bracket + neighbors
      const start = Math.max(0, idx - 1);
      const end = Math.min(brackets.length, idx + 2);
      selected = brackets.slice(start, end);
    } else if (targetINR < brackets[0].min) {
      selected = brackets.slice(0, 3);
    } else {
      selected = brackets.slice(-3);
    }
  }

  const localitySlug = canonicalLocality(locality).slug;
  const links: RelatedLink[] = selected.map((b) => ({
    label: b.label,
    href: localitySlug
      ? `/localities/${localitySlug}?budget=${b.min}-${b.max}`
      : `/search?q=budget+${b.min}+to+${b.max}`,
  }));

  if (links.length === 0) return null;
  return { heading: "Similar Budgets", links };
}

// ── Configuration Suggestions ─────────────────────────────────────

function buildConfigSuggestions(
  bhk: number | null,
  locality: string | null,
  intent: string | null,
): RelatedSection | null {
  const allBhk = ["1", "2", "3", "4", "5"];
  const nearby = bhk
    ? allBhk.filter((b) => Math.abs(Number(b) - bhk) <= 1 && Number(b) !== bhk)
    : allBhk.slice(0, 4);

  const localitySlug = canonicalLocality(locality).slug;
  const intentPart = intentSlug(intent);
  const links: RelatedLink[] = nearby.map((b) => {
    const label = `${b} BHK`;
    if (localitySlug) {
      const base = `/localities/${localitySlug}/${b}-bhk`;
      return { label, href: intentPart ? `${base}?intent=${intentPart}` : base };
    }
    return { label, href: `/search?q=${b}+bhk` };
  });

  if (links.length === 0) return null;
  return { heading: "Configurations", links };
}

// ── Property Types ────────────────────────────────────────────────

async function buildPropertyTypes(
  locality: string,
  asset: string | null,
): Promise<RelatedSection | null> {
  const canon = canonicalLocality(locality);
  if (!canon.slug) return null;
  const db = getServerSupabase();
  if (!db) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await db
    .from("listings_unified")
    .select("property_type")
    .eq("canonical_micro_market_slug", canon.slug)
    .gte("last_seen", thirtyDaysAgo)
    .not("property_type", "is", null)
    .neq("property_type", "")
    .limit(500);

  if (!data || data.length === 0) return null;

  const counts = new Map<string, number>();
  for (const row of data) {
    const pt = (row.property_type || "").toLowerCase().trim();
    if (!pt || pt === "other") continue;
    counts.set(pt, (counts.get(pt) || 0) + 1);
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const links: RelatedLink[] = sorted.map(([pt]) => ({
    label: pt.charAt(0).toUpperCase() + pt.slice(1),
    href: `/localities/${canon.slug}?type=${encodeURIComponent(pt)}`,
  }));

  if (links.length === 0) return null;
  return { heading: "Property Types", links };
}

// ── Buildings / Societies ─────────────────────────────────────────

async function buildTopBuildings(
  locality: string,
): Promise<RelatedSection | null> {
  const canon = canonicalLocality(locality);
  if (!canon.slug) return null;
  const db = getServerSupabase();
  if (!db) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await db
    .from("listings_unified")
    .select("building_name")
    .eq("canonical_micro_market_slug", canon.slug)
    .gte("last_seen", thirtyDaysAgo)
    .not("building_name", "is", null)
    .neq("building_name", "")
    .limit(500);

  if (!data || data.length === 0) return null;

  const counts = new Map<string, number>();
  for (const row of data) {
    const bn = (row.building_name || "").trim();
    if (!bn) continue;
    counts.set(bn, (counts.get(bn) || 0) + 1);
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const links: RelatedLink[] = sorted.map(([name]) => ({
    label: name,
    href: `/buildings/${slugify(name)}`,
  }));

  if (links.length === 0) return null;
  return {
    heading: "Top Buildings",
    links,
    viewMoreHref: `/localities/${canon.slug}`,
  };
}

// ── Nearby Landmarks ──────────────────────────────────────────────

async function buildNearbyLandmarks(
  locality: string,
): Promise<RelatedSection | null> {
  const canon = canonicalLocality(locality);
  if (!canon.slug) return null;
  const db = getServerSupabase();
  if (!db) return null;

  const { data } = await db
    .from("locality_reference")
    .select("landmarks, sub_locality")
    .eq("parent_locality", canon.label)
    .limit(20);

  if (!data || data.length === 0) return null;

  const landmarks = new Set<string>();
  for (const row of data) {
    if (Array.isArray(row.landmarks)) {
      for (const lm of row.landmarks) {
        if (lm && typeof lm === "string") landmarks.add(lm);
      }
    }
    // Sub-localities also serve as landmarks
    if (row.sub_locality) landmarks.add(row.sub_locality);
  }

  const links: RelatedLink[] = Array.from(landmarks)
    .slice(0, 6)
    .map((lm) => ({
      label: lm,
      href: `/localities/${canon.slug}?near=${encodeURIComponent(lm)}`,
    }));

  if (links.length === 0) return null;
  return { heading: "Nearby Landmarks", links };
}

// ── Market Insights ───────────────────────────────────────────────

function buildMarketInsights(
  locality: string,
): RelatedSection | null {
  const canon = canonicalLocality(locality);
  if (!canon.slug) return null;

  const links: RelatedLink[] = [
    { label: "Recently Added", href: `/localities/${canon.slug}?sort=recent` },
    { label: "For Rent", href: `/localities/${canon.slug}/rent` },
    { label: "For Sale", href: `/localities/${canon.slug}/sale` },
  ];

  return { heading: "Market Insights", links };
}

// ── Top Brokers ───────────────────────────────────────────────────

async function buildTopBrokers(
  locality: string,
): Promise<RelatedSection | null> {
  const canon = canonicalLocality(locality);
  if (!canon.slug) return null;
  const db = getServerSupabase();
  if (!db) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await db
    .from("listings_unified")
    .select("broker_name")
    .eq("canonical_micro_market_slug", canon.slug)
    .gte("last_seen", thirtyDaysAgo)
    .not("broker_name", "is", null)
    .neq("broker_name", "")
    .limit(500);

  if (!data || data.length === 0) return null;

  const counts = new Map<string, number>();
  for (const row of data) {
    const bn = (row.broker_name || "").trim();
    if (!bn) continue;
    counts.set(bn, (counts.get(bn) || 0) + 1);
  }

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const links: RelatedLink[] = sorted.map(([name]) => ({
    label: `Top Brokers in ${name.split(" ").slice(0, 2).join(" ")}`,
    href: `/search?q=${encodeURIComponent(name)}`,
  }));

  if (links.length === 0) return null;
  return { heading: "Top Brokers", links };
}

// ── Building Deep Links ───────────────────────────────────────────

function canonicalBhk(value: string): string {
  const raw = value.trim().replace(/\s*bhk\s*$/i, "");
  const number = Number(raw);
  if (!Number.isFinite(number)) return value.trim();
  return Number.isInteger(number) ? String(number) : String(number);
}

async function buildBuildingDeepLinks(
  buildingName: string,
  microMarket: string,
  bhk: string | null,
): Promise<RelatedSection | null> {
  const cleanName = (buildingName || "").trim();
  if (!cleanName) return null;
  const db = getServerSupabase();
  if (!db) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data } = await db
    .from("listings_unified")
    .select("bhk, intent")
    .eq("building_name", cleanName)
    .gte("last_seen", thirtyDaysAgo)
    .limit(200);

  if (!data || data.length === 0) return null;

  const bhkSet = new Set<string>();
  for (const row of data) {
    if (row.bhk) bhkSet.add(canonicalBhk(String(row.bhk)));
  }

  const links: RelatedLink[] = [];
  const slug = slugify(cleanName);

  for (const b of Array.from(bhkSet).sort()) {
    links.push({
      label: `${b} BHK in ${cleanName}`,
      href: `/buildings/${slug}?bhk=${encodeURIComponent(b)}`,
    });
    if (links.length >= 5) break;
  }

  if (links.length === 0) return null;
  return {
    heading: `More in ${cleanName}`,
    links,
    viewMoreHref: `/buildings/${slug}`,
  };
}

// ── Main: Search Page ─────────────────────────────────────────────

export async function generateSearchRelated(
  parsed: ParsedQuery,
): Promise<RelatedSection[]> {
  const locality = parsed.matchedLocalities?.[0]?.locality || parsed.locality;
  if (!locality) return [];

  const sections: Array<RelatedSection | null> = await Promise.all([
    buildNearbyLocalities(locality, parsed.intent),
    buildTopBuildings(locality),
    buildNearbyLandmarks(locality),
    buildPropertyTypes(locality, parsed.asset),
  ]);

  // Add computed sections (no DB calls)
  const budget = buildBudgetSuggestions(parsed.minPrice, parsed.maxPrice, parsed.intent, locality);
  const configs = buildConfigSuggestions(parsed.bhk, locality, parsed.intent);
  const insights = buildMarketInsights(locality);

  sections.push(budget, configs, insights);

  return sections.filter((s): s is RelatedSection => s !== null && s.links.length > 0);
}

// ── Main: Listing Detail Page ─────────────────────────────────────

export async function generateListingRelated(
  listing: ListingRow,
): Promise<RelatedSection[]> {
  const locality = listing.micro_market;
  if (!locality) return [];

  const sections: Array<RelatedSection | null> = await Promise.all([
    listing.building_name
      ? buildBuildingDeepLinks(listing.building_name, locality, listing.bhk)
      : Promise.resolve(null),
    buildNearbyLocalities(locality, listing.intent),
    buildTopBuildings(locality),
    buildNearbyLandmarks(locality),
    buildPropertyTypes(locality, null),
  ]);

  const configs = buildConfigSuggestions(
    listing.bhk ? parseInt(listing.bhk) || null : null,
    locality,
    listing.intent,
  );
  const insights = buildMarketInsights(locality);

  sections.push(configs, insights);

  return sections.filter((s): s is RelatedSection => s !== null && s.links.length > 0);
}
