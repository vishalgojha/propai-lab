import { getAllBuildings, getAllLocalities, type BuildingSummary, type LocalitySummary } from "./localities";
import { getServerSupabase, slugify } from "./supabase";

export type ParsedNaturalSearch = {
  query: string;
  locality: string | null;
  localityStated: boolean;
  statedLocalityText: string | null;
  bhk: number | null;
  intent: "rent" | "sale" | null;
  minPrice: number | null;
  maxPrice: number | null;
  furnishing: "furnished" | "semi-furnished" | "unfurnished" | null;
  tokens: string[];
  matchedLocalities: LocalitySummary[];
};

export type NaturalSearchRow = {
  id: number;
  intent: string | null;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  area_sqft: number | null;
  furnishing: string | null;
  location_label: string | null;
  building_name: string | null;
  landmark_name: string | null;
  micro_market: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  first_seen: string | null;
  last_seen: string | null;
  observation_count: number | null;
};

export type NaturalSearchResult = NaturalSearchRow & {
  score: number;
  priceLabel: string;
  matchedOn: string[];
  resultType: "locality" | "building";
};

export type NaturalSearchState = {
  parsed: ParsedNaturalSearch;
  results: NaturalSearchResult[];
  totalScanned: number;
  suggestions: LocalitySummary[];
  hasData: boolean;
  localityUnmatched: boolean;
  localitySuggestions: LocalitySummary[];
};

const MONEY_UNITS: Record<string, number> = {
  cr: 1_00_00_000,
  crore: 1_00_00_000,
  crores: 1_00_00_000,
  l: 1_00_000,
  lac: 1_00_000,
  lakh: 1_00_000,
  lakhs: 1_00_000,
  k: 1_000,
  thousand: 1_000,
};

const LISTING_FIELDS = [
  "id",
  "intent",
  "bhk",
  "price",
  "price_unit",
  "area_sqft",
  "furnishing",
  "location_label",
  "building_name",
  "landmark_name",
  "micro_market",
  "broker_name",
  "broker_phone",
  "first_seen",
  "last_seen",
  "observation_count",
] as const;

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatPrice(value: number | null): string {
  if (value == null) return "Price on request";
  if (value >= 1_00_00_000) {
    const cr = value / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(1)} Cr`;
  }
  if (value >= 1_00_000) {
    const l = value / 1_00_000;
    return `₹${l % 1 === 0 ? l : l.toFixed(1)} L`;
  }
  return `₹${value.toLocaleString("en-IN")}`;
}

function moneyValue(amount: string, unit?: string | null): number | null {
  const numeric = Number.parseFloat(amount);
  if (!Number.isFinite(numeric)) return null;
  const multiplier = unit ? MONEY_UNITS[unit.toLowerCase()] : null;
  if (multiplier) return Math.round(numeric * multiplier);
  return Math.round(numeric);
}

function parseBhk(query: string): number | null {
  const lower = query.toLowerCase();
  if (/\bstudio\b/.test(lower)) return 0;
  const match = lower.match(/\b(\d+(?:\.\d+)?)\s*bhk\b/);
  if (!match) return null;
  return Number.parseFloat(match[1]);
}

function parseIntent(query: string): "rent" | "sale" | null {
  const lower = query.toLowerCase();
  if (/\b(rent|rental|lease|leasing|tenant)\b/.test(lower)) return "rent";
  if (/\b(sale|sell|selling|purchase|buy|buying|resale)\b/.test(lower)) return "sale";
  return null;
}

function parseFurnishing(query: string): ParsedNaturalSearch["furnishing"] {
  const lower = query.toLowerCase();
  if (/\bfully\s+furnished\b|\bfull\s*furn\b|\bff\b/.test(lower)) return "furnished";
  if (/\bsemi\s+furnished\b|\bsemi\s*fur\b|\bsf\b/.test(lower)) return "semi-furnished";
  if (/\bunfurnished\b|\bnon[-\s]?furnished\b/.test(lower)) return "unfurnished";
  return null;
}

function parseBudget(query: string): { minPrice: number | null; maxPrice: number | null } {
  const lower = query.toLowerCase();
  const unitHint = lower.match(/\b(cr|crores?|lacs?|lakhs?|k|thousand)\b/);

  const range = lower.match(
    /\b(?:budget|between|from|within|under|below|max|upto|up to)?\s*(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:-|to|and|–|—)\s*(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)?\b/,
  );
  if (range) {
    const unit = range[3] || unitHint?.[1] || null;
    const min = moneyValue(range[1], unit);
    const max = moneyValue(range[2], unit);
    return { minPrice: min, maxPrice: max };
  }

  const under = lower.match(
    /\b(?:budget|under|below|max|upto|up to|within|less than)\s*(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)?\b/,
  );
  if (under) {
    const unit = under[2] || unitHint?.[1] || null;
    const value = moneyValue(under[1], unit);
    return { minPrice: null, maxPrice: value };
  }

  return { minPrice: null, maxPrice: null };
}

export function findLocalityMatches(query: string, localities: LocalitySummary[]): LocalitySummary[] {
  const qSlug = slugify(query);
  const qText = normalizeText(query);
  return localities
    .map((loc) => {
      const locSlug = slugify(loc.locality);
      const locText = normalizeText(loc.locality);
      let score = 0;
      if (!locSlug) return { loc, score };
      if (qSlug === locSlug || qText === locText) score = 100;
      else if (qSlug.includes(locSlug) || qText.includes(locText)) score = 80;
      else if (locSlug.includes(qSlug) && qSlug.length >= 3) score = 55;
      else if (
        qText
          .split(" ")
          .filter((part) => part.length >= 3)
          .every((part) => locText.includes(part))
      ) {
        score = 40;
      }
      return { loc, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.loc.listingCount - a.loc.listingCount)
    .slice(0, 3)
    .map((entry) => entry.loc);
}

// Detects whether the user actually named a locality in the query, even if it
// didn't resolve to a known gazetteer entry. Compound forms ("Bandra East",
// "Andheri West") are recognised as a base name + directional suffix so that a
// stated locality is never silently discarded into a broad, locality-less search.
function detectLocalityStated(query: string): boolean {
  const qText = normalizeText(query);
  const parts = qText.split(" ").filter(Boolean);
  const directional = /\b(east|west|north|south|central|e|w|n|s)\b/;
  const baseName =
    /(bandra|andheri|goregaon|juhu|powai|khar|chembur|thane|navi|mumbai|delhi|bangalore|bengaluru|hyderabad|pune|chennai|kolkata|gurgaon|gurugram|noida)/;

  // "in <locality>" / "at <locality>" / "near <locality>" prepositions
  if (/\b(in|at|near|around|locality|area)\b/.test(qText)) return true;

  // base name present, optionally followed by a directional suffix
  for (let i = 0; i < parts.length; i += 1) {
    if (baseName.test(parts[i])) {
      const next = parts[i + 1];
      if (!next || directional.test(next)) return true;
    }
  }
  return false;
}

// Extracts the human-readable locality phrase the user stated, for display in
// the "we don't track X yet" banner. Unlike detectLocalityStated (boolean),
// this returns the actual phrase — e.g. "3 bhk in Bandra East" -> "Bandra East".
// Extraction stops at the next stop token (bhk, budget keywords, end) so the
// BHK/budget portion of the query is never captured as the locality.
function extractStatedLocalityPhrase(query: string): string | null {
  const qText = normalizeText(query);
  const parts = qText.split(" ").filter(Boolean);
  if (parts.length === 0) return null;

  const directional = /\b(east|west|north|south|central)\b/;
  const baseName =
    /(bandra|andheri|goregaon|juhu|powai|khar|chembur|thane|navi|mumbai|delhi|bangalore|bengaluru|hyderabad|pune|chennai|kolkata|gurgaon|gurugram|noida)/;
  const stopAfter = /\b(bhk|rk|studio|budget|under|below|max|upto|up to|within|less than|rent|rental|sale|sell|buy|buying|purchase|furnished|semi|unfurnished|sqft|sq\.?\s*ft|area)\b/;

  // Case 1: "in/at/near <locality> [stop token | end]"
  const prepMatch = qText.match(/\b(in|at|near|around|locality|area)\b\s+(.+)$/);
  if (prepMatch) {
    const after = prepMatch[2];
    const cut = after.split(stopAfter)[0].trim();
    const tokens = cut.split(" ").filter((t) => t.length > 0);
    if (tokens.length > 0) {
      return titleCase(tokens.join(" "));
    }
  }

  // Case 2: base name (+ optional directional) without a preposition.
  for (let i = 0; i < parts.length; i += 1) {
    if (baseName.test(parts[i])) {
      const captured = [parts[i]];
      if (parts[i + 1] && directional.test(parts[i + 1])) captured.push(parts[i + 1]);
      return titleCase(captured.join(" "));
    }
  }

  return null;
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function parsedQueryTokens(query: string): string[] {
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "any",
    "at",
    "around",
    "budget",
    "for",
    "in",
    "looking",
    "near",
    "of",
    "on",
    "show",
    "the",
    "to",
    "under",
    "with",
    "want",
    "wanting",
    "within",
  ]);
  return normalizeText(query)
    .split(" ")
    .filter((token) => token.length >= 3 && !stopwords.has(token));
}

export function parseSearchQuery(query: string, localities: LocalitySummary[]): ParsedNaturalSearch {
  const parsedBhk = parseBhk(query);
  const parsedIntent = parseIntent(query);
  const parsedFurnishing = parseFurnishing(query);
  const { minPrice, maxPrice } = parseBudget(query);
  const matchedLocalities = findLocalityMatches(query, localities);

  return {
    query,
    locality: matchedLocalities[0]?.locality ?? null,
    localityStated: detectLocalityStated(query),
    statedLocalityText: extractStatedLocalityPhrase(query),
    bhk: parsedBhk,
    intent: parsedIntent,
    minPrice,
    maxPrice,
    furnishing: parsedFurnishing,
    tokens: parsedQueryTokens(query),
    matchedLocalities,
  };
}

export async function parseNaturalSearchQuery(query: string): Promise<ParsedNaturalSearch> {
  const localities = await getAllLocalities();
  return parseSearchQuery(query, localities);
}

function rowBhkValue(bhk: string | null): number | null {
  if (!bhk) return null;
  const lower = bhk.toLowerCase();
  if (lower.includes("studio")) return 0;
  const match = lower.match(/\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

function rowIntentValue(intent: string | null): "rent" | "sale" | null {
  const lower = (intent || "").toLowerCase();
  if (/\b(rent|rental|lease)\b/.test(lower)) return "rent";
  if (/\b(sale|sell|buy|purchase)\b/.test(lower)) return "sale";
  return null;
}

function rowSearchText(row: NaturalSearchRow): string {
  return normalizeText(
    [
      row.building_name,
      row.location_label,
      row.landmark_name,
      row.micro_market,
      row.broker_name,
      row.broker_phone,
      row.intent,
      row.bhk,
      row.furnishing,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function scoreRow(row: NaturalSearchRow, parsed: ParsedNaturalSearch): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = [];
  let score = 0;
  const text = rowSearchText(row);

  if (parsed.locality && row.micro_market && slugify(row.micro_market) === slugify(parsed.locality)) {
    score += 80;
    matchedOn.push(parsed.locality);
  }

  if (parsed.bhk != null) {
    const rowBhk = rowBhkValue(row.bhk);
    if (rowBhk === parsed.bhk) {
      score += 40;
      matchedOn.push(`${parsed.bhk} BHK`);
    } else if (rowBhk != null && Math.abs(rowBhk - parsed.bhk) < 0.5) {
      score += 20;
      matchedOn.push(`${parsed.bhk} BHK-ish`);
    }
  }

  if (parsed.intent) {
    const rowIntent = rowIntentValue(row.intent);
    if (rowIntent === parsed.intent) {
      score += 25;
      matchedOn.push(parsed.intent);
    }
  }

  if (parsed.furnishing) {
    const furnishingText = normalizeText(row.furnishing || "");
    const matches =
      (parsed.furnishing === "furnished" && furnishingText.includes("furnished") && !furnishingText.includes("semi")) ||
      (parsed.furnishing === "semi-furnished" && furnishingText.includes("semi")) ||
      (parsed.furnishing === "unfurnished" && furnishingText.includes("unfurnished"));
    if (matches) {
      score += 12;
      matchedOn.push(parsed.furnishing);
    }
  }

  if (parsed.minPrice != null || parsed.maxPrice != null) {
    const price = typeof row.price === "number" ? row.price : null;
    if (price != null) {
      const inRange =
        (parsed.minPrice == null || price >= parsed.minPrice) &&
        (parsed.maxPrice == null || price <= parsed.maxPrice);
      if (inRange) {
        score += 35;
        matchedOn.push("budget");
      }
    }
  }

  for (const token of parsed.tokens) {
    if (text.includes(token)) score += 4;
  }

  if (row.observation_count && row.observation_count > 1) {
    score += Math.min(12, row.observation_count);
  }

  if (row.last_seen) {
    const ageMs = Date.now() - new Date(row.last_seen).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0) {
      score += Math.max(0, 10 - Math.min(10, Math.floor(ageMs / 86_400_000)));
    }
  }

  return { score, matchedOn };
}

export function matchesHardFilters(row: NaturalSearchRow, parsed: ParsedNaturalSearch): boolean {
  if (parsed.locality && row.micro_market && slugify(row.micro_market) !== slugify(parsed.locality)) {
    return false;
  }

  if (parsed.bhk != null) {
    const rowBhk = rowBhkValue(row.bhk);
    if (rowBhk == null || rowBhk !== parsed.bhk) return false;
  }

  if (parsed.intent) {
    const rowIntent = rowIntentValue(row.intent);
    if (rowIntent != null && rowIntent !== parsed.intent) return false;
  }

  if (parsed.furnishing) {
    const furnishingText = normalizeText(row.furnishing || "");
    const matches =
      (parsed.furnishing === "furnished" && furnishingText.includes("furnished") && !furnishingText.includes("semi")) ||
      (parsed.furnishing === "semi-furnished" && furnishingText.includes("semi")) ||
      (parsed.furnishing === "unfurnished" && furnishingText.includes("unfurnished"));
    if (!matches) return false;
  }

  if (parsed.minPrice != null || parsed.maxPrice != null) {
    if (typeof row.price !== "number") return false;
    if (parsed.minPrice != null && row.price < parsed.minPrice) return false;
    if (parsed.maxPrice != null && row.price > parsed.maxPrice) return false;
  }

  return true;
}

export function describeNaturalSearch(parsed: ParsedNaturalSearch): string {
  const parts: string[] = [];
  if (parsed.bhk != null) parts.push(parsed.bhk === 0 ? "Studio" : `${parsed.bhk} BHK`);
  if (parsed.locality) parts.push(parsed.locality);
  if (parsed.intent) parts.push(parsed.intent === "rent" ? "rentals" : "sale");
  if (parsed.minPrice != null || parsed.maxPrice != null) {
    const min = formatPrice(parsed.minPrice);
    const max = formatPrice(parsed.maxPrice);
    parts.push(
      parsed.minPrice != null && parsed.maxPrice != null
        ? `${min} to ${max}`
        : parsed.maxPrice != null
          ? `under ${max}`
          : `from ${min}`,
    );
  }
  if (parsed.furnishing) parts.push(parsed.furnishing);
  return parts.join(" • ");
}

export async function searchNaturalLanguageListings(
  query: string,
  limit = 24,
): Promise<NaturalSearchState> {
  const db = getServerSupabase();
  const localities = await getAllLocalities();
  const parsed = parseSearchQuery(query, localities);
  const matchedSuggestions =
    parsed.matchedLocalities.length > 0 ? parsed.matchedLocalities : localities.slice(0, 6);

  // The user named a locality that we could not resolve to any tracked
  // gazetteer entry. Do NOT silently fall back to a broad, locality-less
  // search — that erodes trust by mixing unrelated localities. Surface a
  // "no matches for that locality" state with honest suggestions instead.
  if (parsed.localityStated && !parsed.locality) {
    return {
      parsed,
      results: [],
      totalScanned: 0,
      suggestions: matchedSuggestions,
      hasData: Boolean(db),
      localityUnmatched: true,
      localitySuggestions: localities.slice(0, 6),
    };
  }

  if (!db || !query.trim()) {
    return {
      parsed,
      results: [],
      totalScanned: 0,
      suggestions: matchedSuggestions,
      hasData: Boolean(db),
      localityUnmatched: false,
      localitySuggestions: [],
    };
  }

  const fields = LISTING_FIELDS.join(", ");

  // Paginate the full table so NO matching listing is skipped. Supabase caps a
  // single select at 1000 rows; a bare .limit(400) would never surface the
  // 1001st+ listing. We apply the locality filter at the DB layer (when a
  // locality matched) and run the remaining hard filters in-memory below.
  const fetchRows = async (narrowed: boolean): Promise<NaturalSearchRow[]> => {
    const out: NaturalSearchRow[] = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      let qb = db
        .from("listings")
        .select(fields)
        .order("last_seen", { ascending: false })
        .range(offset, offset + PAGE - 1);

      if (narrowed && parsed.locality) {
        qb = qb.eq("micro_market", parsed.locality);
      }

      const { data, error } = await qb;
      if (error) {
        console.error("searchNaturalLanguageListings error:", error.message);
        return out;
      }
      const page = (data ?? []) as unknown as NaturalSearchRow[];
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  };

  // When a locality matched, narrow at the DB layer AND enforce it as a hard
  // filter below. Never broad-fetch just because narrow returned few rows.
  const rows = await fetchRows(Boolean(parsed.locality));

  // Build a set of known building names so we can classify a result as a
  // building vs a locality (a building must never render as a "Locality" card).
  const knownBuildings = await getAllBuildings();
  const buildingNameSet = new Set(
    knownBuildings.map((b: BuildingSummary) => slugify(b.name)).filter(Boolean),
  );
  const localitySlugSet = new Set(
    localities.map((l: LocalitySummary) => l.slug).filter(Boolean),
  );

  const classify = (row: NaturalSearchRow): "locality" | "building" => {
    const marketSlug = row.micro_market ? slugify(row.micro_market) : null;
    if (marketSlug && localitySlugSet.has(marketSlug)) return "locality";
    const buildingSlug = row.building_name ? slugify(row.building_name) : null;
    if (buildingSlug && buildingNameSet.has(buildingSlug)) return "building";
    // Default unknown market values to building only when they look like a
    // building; otherwise keep "locality" so the chip is at least sensible.
    return marketSlug ? "locality" : "building";
  };

  const ranked = rows
    .filter((row) => matchesHardFilters(row, parsed))
    .map((row) => {
      const { score, matchedOn } = scoreRow(row, parsed);
      const priceLabel = formatPrice(row.price);
      return {
        ...row,
        score,
        matchedOn,
        priceLabel,
        resultType: classify(row),
      };
    })
    .sort((a, b) => b.score - a.score || (b.last_seen ? new Date(b.last_seen).getTime() : 0) - (a.last_seen ? new Date(a.last_seen).getTime() : 0))
    .slice(0, limit);

  return {
    parsed,
    results: ranked,
    totalScanned: rows.length,
    suggestions: matchedSuggestions,
    hasData: true,
    localityUnmatched: false,
    localitySuggestions: [],
  };
}
