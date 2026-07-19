import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMarketSummary, logToolCall } from "../data.ts";
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

export function registerGeographyTools(server: McpServer, context: ToolContext) {
  server.registerTool("location_search", {
    description: "Search for real estate activity in a location — listing volume, price bands, top areas",
    inputSchema: {
      location: z.string().describe("Locality or area (e.g. 'Bandra West', 'Powai', 'Worli')"),
      city: z.string().optional(),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional().default("all"),
      days: z.number().optional().default(30),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "location_search", input);
    const result = await getMarketSummary({ locality: input.location, city: input.city, property_type: input.property_type, days: input.days });
    const parts = [
      `${input.location}: ${result.listing_count} listings`,
      result.avg_price_cr != null ? `avg sale ${formatCurrencyCr(result.avg_price_cr)}` : null,
      result.avg_rent_per_month != null ? `avg rent ${formatCurrencyCr(result.avg_rent_per_month)}/mo` : null,
      result.avg_price_per_sqft != null ? `avg ₹${result.avg_price_per_sqft.toLocaleString("en-IN")}/sqft` : null,
    ].filter(Boolean) as string[];
    return textResponse(parts.join(", "), result);
  });

  server.registerTool("location_nearby", {
    description: "Find market activity near a location",
    inputSchema: {
      location: z.string().describe("Central location or landmark"),
      radius_km: z.number().optional().default(1),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional().default("all"),
      limit: z.number().optional().default(20),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "location_nearby", input);
    const result = await getMarketSummary({ locality: input.location, property_type: input.property_type, days: 30 });
    return textResponse(`Activity near ${input.location} (${input.radius_km}km): ${result.listing_count} listings`, result);
  });

}
