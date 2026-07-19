import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMarketSummary, logToolCall } from "../data.ts";
import { executeMarketSearch } from "../marketSearch.ts";
import { formatCurrencyCr } from "../format.ts";
import type { ToolContext } from "../types.js";

function textResponse(text: string, structured?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured as Record<string, unknown> | undefined,
  };
}

function brokerId(context?: ToolContext) {
  return context?.user?.broker_id || context?.user?.id;
}

export function registerMarketTools(server: McpServer, context: ToolContext) {
  server.registerTool("market_search", {
    description: "Search the property market for listings, requirements, brokers — understands natural language like '3 BHK in Bandra West under 2 Cr'",
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      location: z.string().optional().describe("Locality to narrow results"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      limit: z.number().optional().default(20),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "market_search", input);
    const result = await executeMarketSearch({ query: input.query, locality: input.location, city: input.city, limit: input.limit });
    const items = result.results || [];
    return textResponse(items.length ? `${items.length} result(s) for "${input.query}"` : 'No results found. Try a broader search.', result);
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
    const result = await getMarketSummary({ locality: input.location, city: input.city, property_type: input.property_type, bhk: input.bhk, days: input.days });
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
    const result = await getMarketSummary({ locality: input.location, city: input.city, days: input.days });
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
