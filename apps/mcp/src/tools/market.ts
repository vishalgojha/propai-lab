import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMarketSummary, logToolCall, toMarketSearchRow } from "../data.ts";
import { executeMarketSearch } from "../marketSearch.ts";
import { formatCurrencyCr } from "../format.ts";
import { reportMarketResultAnomalies, reportMcpParserError } from "../anomalies.ts";
import type { ToolContext } from "../types.js";
import { deprecatedAlias } from "../compat.ts";

function textResponse(text: string, structured?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured as Record<string, unknown> | undefined,
  };
}

function brokerId(context?: ToolContext) {
  return context?.user?.broker_id || context?.user?.id;
}

function tenantId(context?: ToolContext) {
  const id = context?.user?.tenant_id;
  if (!id) throw new Error("Authenticated organization scope is required");
  return id;
}

function marketText(result: { query: string; explanation: string; results?: unknown[] }) {
  const rows = (result.results || []).map((row) => {
    const value = row as Record<string, unknown>;
    return value.listing_type ? toMarketSearchRow(value as any) : value;
  });
  return rows.length
    ? JSON.stringify({ query: result.query, explanation: result.explanation, results: rows })
    : "No results found. Try a broader search.";
}

async function auditedMarketSearch(input: { query: string; tenantId: string; locality?: string; city?: string; limit?: number; propertyType?: "sale" | "rent" | "lease" | "all"; budgetMinInr?: number; budgetMaxInr?: number; furnishing?: string; minCarParks?: number; petsAllowed?: boolean; communityRestrictions?: string; dealType?: "direct" | "side_by_side"; minLastSeen?: string; sort?: "recency" | "rent" | "relevance"; offset?: number }) {
  try {
    const result = await executeMarketSearch(input);
    const rows = (result.results || []).map((row) => {
      const value = row as Record<string, unknown>;
      return value.listing_type ? toMarketSearchRow(value as any) : value;
    });
    // Fire-and-forget: anomaly logging/email must never add latency or turn a
    // usable market response into an MCP failure.
    reportMarketResultAnomalies(input.query, rows);
    return { result, rows };
  } catch (error) {
    reportMcpParserError(input.query, error);
    throw error;
  }
}

export function registerMarketTools(server: McpServer, context: ToolContext) {
  server.registerTool("market_search", {
    description: "Search the property market for listings, requirements, brokers — understands natural language like '3 BHK in Bandra West under 2 Cr'. Always report each result's posted_on and last_seen_on when present; never omit the date/freshness fields.",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      location: z.string().optional().describe("Locality to narrow results"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      limit: z.number().optional().default(20),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional(),
      budget_min_inr: z.number().optional(),
      budget_max_inr: z.number().optional(),
      furnishing: z.string().optional(),
      min_car_parks: z.number().int().min(0).optional(),
      pets_allowed: z.boolean().optional(),
      community_restrictions: z.string().optional(),
      deal_type: z.enum(["direct", "side_by_side"]).optional(),
      min_last_seen: z.string().optional(),
      sort: z.enum(["recency", "rent", "relevance"]).optional().default("recency"),
      offset: z.number().int().min(0).optional().default(0),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "market_search", input);
    const { result, rows } = await auditedMarketSearch({ query: input.query, tenantId: tenantId(context), locality: input.location, city: input.city, limit: input.limit, propertyType: input.property_type, budgetMinInr: input.budget_min_inr, budgetMaxInr: input.budget_max_inr, furnishing: input.furnishing, minCarParks: input.min_car_parks, petsAllowed: input.pets_allowed, communityRestrictions: input.community_restrictions, dealType: input.deal_type, minLastSeen: input.min_last_seen, sort: input.sort, offset: input.offset });
    return textResponse(marketText(result), {
      ...result,
      results: rows,
    });
  });

  server.registerTool("search_listings", {
    description: "Search for property listings — ChatGPT-compatible alias for market_search. Always report posted_on and last_seen_on when present.",
    inputSchema: {
      query: z.string().describe("Search query (e.g. '3 BHK in Bandra West under 2 Cr')"),
      location: z.string().optional().describe("Locality to narrow results"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      limit: z.number().optional().default(20),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional(),
      budget_min_inr: z.number().optional(),
      budget_max_inr: z.number().optional(),
      furnishing: z.string().optional(),
      min_car_parks: z.number().int().min(0).optional(),
      pets_allowed: z.boolean().optional(),
      community_restrictions: z.string().optional(),
      deal_type: z.enum(["direct", "side_by_side"]).optional(),
      min_last_seen: z.string().optional(),
      sort: z.enum(["recency", "rent", "relevance"]).optional().default("recency"),
      offset: z.number().int().min(0).optional().default(0),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "search_listings", input);
    const { result, rows } = await auditedMarketSearch({ query: input.query, tenantId: tenantId(context), locality: input.location, city: input.city, limit: input.limit, propertyType: input.property_type, budgetMinInr: input.budget_min_inr, budgetMaxInr: input.budget_max_inr, furnishing: input.furnishing, minCarParks: input.min_car_parks, petsAllowed: input.pets_allowed, communityRestrictions: input.community_restrictions, dealType: input.deal_type, minLastSeen: input.min_last_seen, sort: input.sort, offset: input.offset });
    return textResponse(marketText(result), deprecatedAlias({
      ...result,
      results: rows,
    }, "market_search"));
  });

  server.registerTool("market_summary", {
    description: "Get a summary of market activity — listing volume, price bands, top localities",
    inputSchema: {
      location: z.string().optional().describe("Locality to summarize"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional().default("all"),
      bhk: z.number().optional(),
      days: z.number().optional().default(30),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "market_summary", input);
    const result = await getMarketSummary({ tenantId: tenantId(context), locality: input.location, city: input.city, property_type: input.property_type, bhk: input.bhk, days: input.days });
    const parts = [
      `${input.location || "Mumbai"}: ${result.listing_count} listings`,
      result.avg_price_cr != null ? `avg sale ${formatCurrencyCr(result.avg_price_cr)}` : null,
      result.avg_rent_per_month != null ? `avg rent ${formatCurrencyCr(result.avg_rent_per_month)}/mo` : null,
      result.avg_price_per_sqft != null ? `avg ₹${result.avg_price_per_sqft.toLocaleString("en-IN")}/sqft` : null,
    ].filter(Boolean) as string[];
    return textResponse(parts.join(", "), result);
  });

  server.registerTool("market_trends", {
    description: "Get market trends over a time window — listing volume, price movement, top localities",
    inputSchema: {
      location: z.string().optional().describe("Locality"),
      city: z.string().optional(),
      days: z.number().optional().default(90),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "market_trends", input);
    const result = await getMarketSummary({ tenantId: tenantId(context), locality: input.location, city: input.city, days: input.days });
    const top = result.top_localities?.map((l: any) => `${l.locality} (${l.count})`).join(", ") || "";
    const parts = [
      `${input.location || "Mumbai"} over ${input.days}d: ${result.listing_count} listings`,
      result.avg_price_cr != null ? `avg sale ${formatCurrencyCr(result.avg_price_cr)}` : null,
      result.avg_rent_per_month != null ? `avg rent ${formatCurrencyCr(result.avg_rent_per_month)}/mo` : null,
    ].filter(Boolean) as string[];
    return textResponse(
      `${parts.join(", ")}${top ? `\nTop localities: ${top}` : ""}`,
      result,
    );
  });
}
