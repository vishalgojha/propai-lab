import { getAllLocalities, type LocalitySummary } from "./localities";
import { getServerSupabase, slugify } from "./supabase";

export type ParsedNaturalSearch = {
  query: string;
  locality: string | null;
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
};

export type NaturalSearchState = {
  parsed: ParsedNaturalSearch;
  results: NaturalSearchResult[];
  totalScanned: number;
  suggestions: LocalitySummary[];
  hasData: boolean;
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

function findLocalityMatches(query: string, localities: LocalitySummary[]): LocalitySummary[] {
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
      else if (qText.split(" ").filter(Boolean).every((part) => locText.includes(part))) score = 40;
      return { loc, score };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) => b.score - a.score || b.loc.listingCount - a.loc.listingCount,
    )
    .slice(0, 3)
    .map((entry) => entry.loc);
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

function parseSearchQuery(query: string, localities: LocalitySummary[]): ParsedNaturalSearch {
  const parsedBhk = parseBhk(query);
  const parsedIntent = parseIntent(query);
  const parsedFurnishing = parseFurnishing(query);
  const { minPrice, maxPrice } = parseBudget(query);
  const matchedLocalities = findLocalityMatches(query, localities);

  return {
    query,
    locality: matchedLocalities[0]?.locality ?? null,
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

function matchesHardFilters(row: NaturalSearchRow, parsed: ParsedNaturalSearch): boolean {
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
  const suggestions = parsed.matchedLocalities.length > 0 ? parsed.matchedLocalities : localities.slice(0, 6);

  if (!db || !query.trim()) {
    return {
      parsed,
      results: [],
      totalScanned: 0,
      suggestions,
      hasData: Boolean(db),
    };
  }

  const fields = LISTING_FIELDS.join(", ");

  const fetchRows = async (narrowed: boolean) => {
    let queryBuilder = db
      .from("listings")
      .select(fields)
      .order("last_seen", { ascending: false })
      .limit(narrowed ? 300 : 400);

    if (narrowed && parsed.locality) {
      queryBuilder = queryBuilder.eq("micro_market", parsed.locality);
    }

    const { data, error } = await queryBuilder;
    if (error) {
      console.error("searchNaturalLanguageListings error:", error.message);
      return [] as NaturalSearchRow[];
    }
    return (data ?? []) as unknown as NaturalSearchRow[];
  };

  let rows = await fetchRows(Boolean(parsed.locality));
  if (rows.length === 0 && parsed.locality) {
    rows = await fetchRows(false);
  }

  const ranked = rows
    .filter((row) => matchesHardFilters(row, parsed))
    .map((row) => {
      const { score, matchedOn } = scoreRow(row, parsed);
      const priceLabel = formatPrice(row.price);
      return { ...row, score, matchedOn, priceLabel };
    })
    .sort((a, b) => b.score - a.score || (b.last_seen ? new Date(b.last_seen).getTime() : 0) - (a.last_seen ? new Date(a.last_seen).getTime() : 0))
    .slice(0, limit);

  return {
    parsed,
    results: ranked,
    totalScanned: rows.length,
    suggestions,
    hasData: true,
  };
}
