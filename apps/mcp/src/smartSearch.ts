import { supabase } from "./supabase.ts";
import { searchPublicListings, getMarketSummary, getBuildingIntel } from "./data.ts";
import { formatCurrencyCr, formatSqft, formatPerSqft, formatDate } from "./format.ts";
import type { PublicListing } from "./types.js";

type Intent =
  | "listing_search"
  | "requirement_search"
  | "broker_search"
  | "market_insights"
  | "fresh_stream"
  | "building_intel"
  | "general";

type ExtractedParams = {
  locality?: string;
  city?: string;
  bhk?: number;
  propertyType?: "sale" | "rent" | "lease" | "all";
  minPriceCr?: number;
  maxPriceCr?: number;
  buildingName?: string;
  keyword?: string;
  days?: number;
  limit?: number;
};

type SmartSearchResult = {
  intent: Intent;
  query: string;
  params: ExtractedParams;
  explanation: string;
  results: unknown[];
  totalResults: number;
  suggestedFollowUps: string[];
};

const LOCALITY_PATTERN = /(?:in|at|near|around)\s+([A-Za-z\s]+?)(?:\s+(?:mumbai|pune|thane|navi\s*mumbai|delhi|bangalore|hyderabad|chennai|kolkata|ahmedabad|surat|jaipur|lucknow|noida|gurgaon|goa))?(?:\s*(?:,|\||$|for|under|above|below|within|\d|bhd|bhk))/i;
const CITY_PATTERN = /\b(mumbai|pune|thane|navi\s*mumbai|delhi|bangalore|hyderabad|chennai|kolkata|ahmedabad|surat|jaipur|lucknow|noida|gurgaon|goa)\b/i;
const BHK_PATTERN = /(\d+(?:\.\d+)?)\s*(bhd|bhk|rk|bed(?:room)?s?)\b/i;
const PRICE_RANGE_PATTERN = /(?:under|below|upto|less\s*than|within|max)\s*(?:₹?\s*)?(\d+(?:\.\d+)?)\s*(cr|crore|crores|lakh|lakhs|k|thousand)?|(?:above|over|more\s*than|min|from)\s*(?:₹?\s*)?(\d+(?:\.\d+)?)\s*(cr|crore|crores|lakh|lakhs|k|thousand)?|(?:₹?\s*)?(\d+(?:\.\d+)?)\s*(cr|crore|crores|lakh|lakhs|k|thousand)?\s*(?:to|-|–)\s*(?:₹?\s*)?(\d+(?:\.\d+)?)\s*(cr|crore|crores|lakh|lakhs|k|thousand)?/gi;
const DEAL_TYPE_PATTERN = /\b(for\s*)?(sale|rent|lease|rental|outright|purchase)\b/i;
const REQUIREMENT_PATTERN = /\b(looking\s*for|want\s*to\s*buy|need|requirement|buyer\s*(looking|wants)|tenant\s*(looking|wants)|searching\s*for|in\s*need\s*of)\b/i;
const BROKER_PATTERN = /\b(broker|agent|dealer|who\s*deals|specializes?|expert)\b/i;
const MARKET_PATTERN = /\b(market|trend|rate|price\s*tren|demand|supply|comparison|vs|average|cheapest|costly|hot|best)\b/i;
const FRESH_PATTERN = /\b(new|fresh|latest|recent|today|this\s*week|just\s*posted)\b/i;
const BUILDING_PATTERN = /\b(in|at|for)\s+([A-Z][A-Za-z\s]+?)\s+(?:building|tower|complex|heights|park|residency|chambers)\b/i;

const CITIES = new Set(["mumbai", "pune", "thane", "navi mumbai", "delhi", "bangalore", "hyderabad", "chennai", "kolkata", "ahmedabad", "surat", "jaipur", "lucknow", "noida", "gurgaon", "goa"]);

function toCr(amount: number, unit?: string): number {
  const u = (unit || "cr").toLowerCase();
  if (["cr", "crore", "crores"].includes(u)) return amount;
  if (["lakh", "lakhs", "lac", "lacs"].includes(u)) return amount / 100;
  if (["k", "thousand"].includes(u)) return amount / 10000;
  return amount;
}

function classifyIntent(query: string): Intent {
  const lower = query.toLowerCase();

  if (BUILDING_PATTERN.test(query) || lower.includes("building")) {
    return "building_intel";
  }

  if (BROKER_PATTERN.test(lower)) {
    return "broker_search";
  }

  if (MARKET_PATTERN.test(lower) && !DEAL_TYPE_PATTERN.test(lower)) {
    return "market_insights";
  }

  if (FRESH_PATTERN.test(lower)) {
    return "fresh_stream";
  }

  if (REQUIREMENT_PATTERN.test(lower)) {
    return "requirement_search";
  }

  if (DEAL_TYPE_PATTERN.test(lower)) {
    return "listing_search";
  }

  const listingKeywords = /\b(flat|apartment|property|house|villa|office|shop|space|plot|land|studio|penthouse)\b/i;
  if (listingKeywords.test(lower)) {
    return "listing_search";
  }

  return "general";
}

function extractParams(query: string): ExtractedParams {
  const params: ExtractedParams = {};
  const lower = query.toLowerCase();

  const localityMatch = query.match(LOCALITY_PATTERN);
  if (localityMatch) {
    const raw = localityMatch[1].trim().replace(/\s+/g, " ");
    if (!CITIES.has(raw.toLowerCase())) {
      params.locality = raw;
    }
  }

  const cityMatch = query.match(CITY_PATTERN);
  if (cityMatch) {
    params.city = cityMatch[1].trim();
  }

  const bhkMatch = query.match(BHK_PATTERN);
  if (bhkMatch) {
    params.bhk = Math.round(Number(bhkMatch[1]));
  }

  const priceMatches = [...query.matchAll(PRICE_RANGE_PATTERN)];
  for (const m of priceMatches) {
    if (m[1] && m[2]) {
      const val = toCr(Number(m[1]), m[2]);
      if (!params.maxPriceCr || val < params.maxPriceCr) {
        params.maxPriceCr = val;
      }
    }
    if (m[3] && m[4]) {
      const val = toCr(Number(m[3]), m[4]);
      if (!params.minPriceCr || val > params.minPriceCr) {
        params.minPriceCr = val;
      }
    }
    if (m[5] && m[6] && m[7] && m[8]) {
      params.minPriceCr = toCr(Number(m[5]), m[6]);
      params.maxPriceCr = toCr(Number(m[7]), m[8]);
    }
  }

  const dealMatch = query.match(DEAL_TYPE_PATTERN);
  if (dealMatch) {
    const type = dealMatch[2]?.toLowerCase();
    if (type === "sale" || type === "purchase" || type === "outright") {
      params.propertyType = "sale";
    } else if (type === "rent" || type === "rental" || type === "lease") {
      params.propertyType = "rent";
    }
  }

  const freshMatch = query.match(/\b(\d+)\s*(hours?|days?)\b/i);
  if (freshMatch) {
    const num = Number(freshMatch[1]);
    const unit = freshMatch[2].toLowerCase();
    params.days = unit.startsWith("hour") ? Math.max(1, Math.round(num / 24)) : num;
  }

  const limitMatch = query.match(/\b(?:top|limit|show)\s*(\d+)\b/i);
  if (limitMatch) {
    params.limit = Math.min(Number(limitMatch[1]), 50);
  }

  return params;
}

function buildExplanation(intent: Intent, params: ExtractedParams, count: number): string {
  const parts: string[] = [];

  if (intent === "listing_search") parts.push("Find matching listings");
  else if (intent === "requirement_search") parts.push("Find matching requirements");
  else if (intent === "broker_search") parts.push("Search brokers");
  else if (intent === "market_insights") parts.push("Market intelligence");
  else if (intent === "fresh_stream") parts.push("Recent listings");
  else if (intent === "building_intel") parts.push("Building intel");
  else parts.push("Search");

  const filters: string[] = [];
  if (params.propertyType) filters.push(params.propertyType === "sale" ? "for sale" : "for rent");
  if (params.locality) filters.push(`in ${params.locality}`);
  if (params.city) filters.push(params.city);
  if (params.bhk) filters.push(`${params.bhk} BHK`);
  if (params.minPriceCr != null && params.maxPriceCr != null) {
    filters.push(`${formatCurrencyCr(params.minPriceCr * 10000000)}-${formatCurrencyCr(params.maxPriceCr * 10000000)}`);
  } else if (params.maxPriceCr != null) {
    filters.push(`under ${formatCurrencyCr(params.maxPriceCr * 10000000)}`);
  } else if (params.minPriceCr != null) {
    filters.push(`above ${formatCurrencyCr(params.minPriceCr * 10000000)}`);
  }

  if (filters.length) parts.push(`(${filters.join(", ")})`);

  const label = count === 1 ? "result" : "results";
  parts.push(`— ${count} ${label}`);

  return parts.join(" ");
}

function buildFollowUps(intent: Intent, params: ExtractedParams): string[] {
  const suggestions: string[] = [];

  if (intent === "listing_search") {
    if (params.locality) {
      suggestions.push(`Compare prices in nearby localities near ${params.locality}`);
      suggestions.push(`Show requirements from buyers looking in ${params.locality}`);
    }
    if (params.bhk) {
      suggestions.push(`Show ${params.bhk} BHK ${params.propertyType === "rent" ? "rental" : ""} listings with photos`);
    }
    suggestions.push("What is the average price per sqft in this area?");
  } else if (intent === "requirement_search") {
    if (params.locality) {
      suggestions.push(`Match these requirements to available listings in ${params.locality}`);
    }
    suggestions.push("Which brokers are most active with these requirements?");
  } else if (intent === "market_insights") {
    if (params.locality) {
      suggestions.push(`Compare ${params.locality} with nearby areas`);
      suggestions.push("Show price trends for the last 3 months");
    }
    suggestions.push("Which BHK configuration is in highest demand?");
  } else if (intent === "broker_search") {
    suggestions.push("Show this broker's active listings");
    suggestions.push("Find requirements from this broker");
  } else if (intent === "fresh_stream") {
    suggestions.push("Filter these to only sale properties");
    suggestions.push("Filter these to a specific locality");
  }

  suggestions.push("Summarize this data as market insights");

  return suggestions.slice(0, 4);
}

type SmartSearchInput = {
  query: string;
  locality?: string;
  city?: string;
  limit?: number;
};

export async function executeSmartSearch(input: SmartSearchInput): Promise<SmartSearchResult> {
  const query = input.query.trim();
  const intent = classifyIntent(query);
  const extracted = extractParams(query);

  const locality = input.locality || extracted.locality;
  const city = input.city || extracted.city;
  const limit = input.limit || extracted.limit || 20;

  switch (intent) {
    case "listing_search": {
      const rows = await searchPublicListings({
        locality,
        city,
        property_type: extracted.propertyType || "sale",
        bhk: extracted.bhk,
        max_budget_cr: extracted.maxPriceCr,
        budget_min_cr: extracted.minPriceCr,
        listingKind: "listing",
        limit,
      });

      return {
        intent,
        query,
        params: { ...extracted, locality, city, limit },
        explanation: buildExplanation(intent, { ...extracted, locality, city }, rows.length),
        results: rows,
        totalResults: rows.length,
        suggestedFollowUps: buildFollowUps(intent, { ...extracted, locality, city }),
      };
    }

    case "requirement_search": {
      const rows = await searchPublicListings({
        locality,
        city,
        property_type: "all",
        bhk: extracted.bhk,
        max_budget_cr: extracted.maxPriceCr,
        budget_min_cr: extracted.minPriceCr,
        listingKind: "requirement",
        limit,
      });

      return {
        intent,
        query,
        params: { ...extracted, locality, city, limit },
        explanation: buildExplanation(intent, { ...extracted, locality, city }, rows.length),
        results: rows,
        totalResults: rows.length,
        suggestedFollowUps: buildFollowUps(intent, { ...extracted, locality, city }),
      };
    }

    case "market_insights": {
      const summary = await getMarketSummary({
        locality,
        city,
        property_type: extracted.propertyType || "all",
        bhk: extracted.bhk,
        days: extracted.days || 30,
        limit: Math.max(limit, 50),
      });

      const insights = summary.top_localities.length
        ? summary.top_localities.slice(0, 5).map((t: { locality: string; count: number }) =>
            `${t.locality}: ${t.count} listings`
          ).join("\n")
        : "No locality clusters found.";

      const explanation = [
        `Market summary for ${locality || city || "all areas"}:`,
        `${summary.listing_count} listings in the last ${summary.days} days.`,
        summary.avg_price_cr != null ? `Average price: ${formatCurrencyCr(summary.avg_price_cr)}` : null,
        summary.avg_price_per_sqft != null ? `Average ₹${summary.avg_price_per_sqft.toLocaleString("en-IN")}/sqft` : null,
        `\nTop localities:\n${insights}`,
      ].filter(Boolean).join("\n");

      return {
        intent,
        query,
        params: { ...extracted, locality, city },
        explanation,
        results: [summary],
        totalResults: summary.listing_count,
        suggestedFollowUps: buildFollowUps(intent, { ...extracted, locality, city }),
      };
    }

    case "broker_search": {
      const brokReq = supabase
        .from("profiles")
        .select("id, full_name, phone, email, city, agency_name, locations, app_role");

      if (locality) {
        brokReq.or(`locations.cs.{${locality}},city.ilike.%${locality}%`);
      }
      if (city) {
        brokReq.or(`city.ilike.%${city}%,locations.cs.{${city}}`);
      }

      const { data: profiles, error } = await brokReq.limit(limit);

      if (error) throw new Error(error.message);

      const rows = (profiles || []).filter((p: { app_role?: string }) =>
        p.app_role === "broker" || p.app_role === "super_admin"
      );

      return {
        intent,
        query,
        params: { ...extracted, locality, city, limit },
        explanation: `Found ${rows.length} broker(s) in ${locality || city || "all areas"}`,
        results: rows.map((p: { id: string; full_name?: string; phone?: string; city?: string; agency_name?: string; locations?: string[]; app_role?: string }) => ({
          broker_id: p.id,
          broker_name: p.full_name || "Unknown",
          phone: p.phone || "",
          city: p.city || "",
          agency: p.agency_name || "",
          locations_served: p.locations || [],
          role: p.app_role,
        })),
        totalResults: rows.length,
        suggestedFollowUps: buildFollowUps(intent, { ...extracted, locality, city }),
      };
    }

    case "building_intel": {
      const buildingMatch = query.match(BUILDING_PATTERN);
      const buildingName = buildingMatch?.[2]?.trim() || extracted.buildingName || query.replace(/.*(?:intel|info|about|rates?|price)\s+(?:of|for|at|in)?\s+/, "").trim().split(/\s+/).slice(0, 3).join(" ");

      if (!buildingName || buildingName.length < 3) {
        return {
          intent,
          query,
          params: extracted,
          explanation: "Please specify a building name for intel lookup.",
          results: [],
          totalResults: 0,
          suggestedFollowUps: ["Try 'building intel for Kalpataru Magnus'", "Try 'market rate for Lodha Bellissimo'"],
        };
      }

      const result = await getBuildingIntel({
        building_name: buildingName,
        locality,
        days_back: extracted.days || 90,
      });

      return {
        intent,
        query,
        params: { ...extracted, buildingName, locality },
        explanation: `Building intel for ${buildingName}: ${result.price_benchmarks.sale || result.price_benchmarks.rent ? "price benchmarks available" : "no price benchmarks"}`,
        results: [result],
        totalResults: 1,
        suggestedFollowUps: buildFollowUps(intent, { ...extracted, locality }),
      };
    }

    case "fresh_stream": {
      const rows = await searchPublicListings({
        locality,
        city,
        listingKind: "listing",
        limit,
      });

      return {
        intent,
        query,
        params: { ...extracted, locality, city, limit },
        explanation: `Latest ${rows.length} listing(s) from ${locality || city || "all areas"}`,
        results: rows,
        totalResults: rows.length,
        suggestedFollowUps: buildFollowUps(intent, { ...extracted, locality, city }),
      };
    }

    default: {
      const [listings, requirements] = await Promise.all([
        searchPublicListings({ locality, city, listingKind: "listing", limit: Math.min(limit, 10) }).catch(() => []),
        searchPublicListings({ locality, city, listingKind: "requirement", limit: Math.min(limit, 10) }).catch(() => []),
      ]);

      return {
        intent: "general",
        query,
        params: { ...extracted, locality, city },
        explanation: `Found ${listings.length} listing(s) and ${requirements.length} requirement(s) for "${query}"`,
        results: [...listings, ...requirements],
        totalResults: listings.length + requirements.length,
        suggestedFollowUps: buildFollowUps("general", { ...extracted, locality, city }),
      };
    }
  }
}
