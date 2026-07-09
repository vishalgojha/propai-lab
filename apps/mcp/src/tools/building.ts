import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBuildingIntel, logToolCall } from "../data.ts";
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

const fmtPpsf = (b: any) => b ? `₹${b.avg_price_per_sqft || "N/A"}/sqft` : "N/A";
const fmtPpsfRange = (b: any) => b ? `₹${b.min_price_per_sqft || "N/A"}–${b.max_price_per_sqft || "N/A"}/sqft` : "N/A";

export function registerBuildingTools(server: McpServer, context: ToolContext) {
  server.registerTool("building_search", {
    description: "Search for buildings by name and locality",
    inputSchema: {
      query: z.string().describe("Building name (e.g. 'Kalpataru Magnus', 'Lodha Bellissimo')"),
      location: z.string().optional().describe("Locality filter"),
      limit: z.number().optional().default(10),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "building_search", input);
    const result = await getBuildingIntel({ building_name: input.query, locality: input.location, days_back: 90 });
    if (!result.building_name) return textResponse(`"${input.query}" not found.`, { building: null });
    const ppsf = result.price_benchmarks?.sale;
    return textResponse(
      `${result.building_name}\nLocalities: ${result.matched_localities?.join(", ") || "N/A"}\nSale: ${fmtPpsf(ppsf)}`,
      result,
    );
  });

  server.registerTool("building_profile", {
    description: "Get comprehensive profile for a building — location, price benchmarks, supply-demand",
    inputSchema: {
      building_name: z.string().describe("Building name"),
      location: z.string().optional(),
      days_back: z.number().optional().default(90),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "building_profile", input);
    const result = await getBuildingIntel({ building_name: input.building_name, locality: input.location, days_back: input.days_back });
    if (!result.building_name) return textResponse(`No data for "${input.building_name}".`, null);
    const sale = result.price_benchmarks?.sale;
    const rent = result.price_benchmarks?.rent;
    return textResponse(
      `${result.building_name} @ ${result.matched_localities?.join(", ") || "N/A"}\nSale: ${fmtPpsfRange(sale)} (${sale?.listing_count || 0} samples)\nRent: ${fmtPpsfRange(rent)} (${rent?.listing_count || 0} samples)`,
      result,
    );
  });

  server.registerTool("building_inventory", {
    description: "Get inventory overview — configuration/unit mix for a building",
    inputSchema: {
      building_name: z.string().describe("Building name"),
      location: z.string().optional(),
      days_back: z.number().optional().default(365),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "building_inventory", input);
    const result = await getBuildingIntel({ building_name: input.building_name, locality: input.location, days_back: input.days_back });
    if (!result.building_name) return textResponse(`No inventory for "${input.building_name}".`, null);
    const configs = result.configuration_map?.map((c: any) => `${c.configuration}: ${c.count} (${c.percentage_of_locality}%)`).join("\n") || "None";
    return textResponse(`Configurations in ${result.building_name}:\n${configs}`, result);
  });

  server.registerTool("building_requirements", {
    description: "Get requirement demand for a building — supply-demand balance by locality",
    inputSchema: {
      building_name: z.string().describe("Building name"),
      location: z.string().optional(),
      days_back: z.number().optional().default(90),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "building_requirements", input);
    const result = await getBuildingIntel({ building_name: input.building_name, locality: input.location, days_back: input.days_back });
    if (!result.building_name) return textResponse(`No data for "${input.building_name}".`, null);
    const supply = result.locality_supply?.map((l: any) => `${l.locality}: ${l.listings} listings, ${l.requirements} requirements (${l.ratio})`).join("\n") || "None";
    return textResponse(`Supply-demand for ${result.building_name}:\n${supply}`, result);
  });

  server.registerTool("building_marketPulse", {
    description: "Full market pulse for a building — price benchmarks, supply-demand, configuration mix",
    inputSchema: {
      building_name: z.string().describe("Building name"),
      location: z.string().optional(),
      days_back: z.number().optional().default(90),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "building_marketPulse", input);
    const intel = await getBuildingIntel({ building_name: input.building_name, locality: input.location, days_back: input.days_back });
    if (!intel.building_name) return textResponse(`No pulse data for "${input.building_name}".`, null);
    const sale = intel.price_benchmarks?.sale;
    const rent = intel.price_benchmarks?.rent;
    const supplyTotal = intel.locality_supply?.reduce((s: number, l: any) => s + (l.listings || 0), 0) || 0;
    const reqTotal = intel.locality_supply?.reduce((s: number, l: any) => s + (l.requirements || 0), 0) || 0;
    return textResponse(
      `${intel.building_name} @ ${intel.matched_localities?.join(", ") || "N/A"}\n${supplyTotal} listings / ${reqTotal} requirements (${intel.sample_days}d)\nSale: ${fmtPpsfRange(sale)}\nRent: ${fmtPpsfRange(rent)}`,
      intel,
    );
  });
}
