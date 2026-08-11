import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, matchRequirementToInventory, searchRequirements } from "../data.ts";
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

function requireBrokerId(context?: ToolContext) {
  const id = brokerId(context);
  if (!id) throw new Error("Authenticated broker id is required for this tool");
  return id;
}

export function registerRequirementTools(server: McpServer, context: ToolContext) {
  server.registerTool("requirement_search", {
    description: "Search the typed market requirements directly by locality, asset type, transaction type, budget, and BHK. Use this for buyer or tenant demand; it is distinct from listing search.",
    inputSchema: {
      query: z.string().optional().describe("Optional keyword search across requirement locality, building, and broker fields"),
      location: z.string().optional().describe("Locality or area (e.g. 'Bandra West', 'Powai')"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      asset_type: z.enum(["residential", "commercial", "all"]).optional().default("all"),
      transaction_type: z.enum(["sale", "rent", "all"]).optional().default("all"),
      bhk: z.number().optional().describe("Exact BHK preference"),
      budget_min: z.number().optional().describe("Minimum budget in absolute INR"),
      budget_max: z.number().optional().describe("Maximum budget in absolute INR"),
      limit: z.number().optional().default(10),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "requirement_search", input);
    const requirements = await searchRequirements({
      query: input.query,
      locality: input.location,
      asset_type: input.asset_type,
      transaction_type: input.transaction_type,
      bhk: input.bhk,
      budget_min: input.budget_min,
      budget_max: input.budget_max,
      limit: input.limit,
    });
    return textResponse(
      requirements.length
        ? requirements.map((item, index) => `${index + 1}. ${item.requirement_type} — ${item.locality || "location not specified"} — ${item.bhk_options?.join(", ") || "any configuration"} — ${item.budget_min ?? "?"} to ${item.budget_max ?? "?"} INR`).join("\n")
        : "No matching requirements found.",
      { requirements, filters: input },
    );
  });

  server.registerTool("requirement_match", {
    description: "Match a typed market requirement or explicit requirement filters against listing inventory. This performs requirement-to-listing matching, not generic market search.",
    inputSchema: {
      requirement_id: z.string().optional().describe("Requirement id returned by requirement_search, e.g. residential_rent:123"),
      raw_text: z.string().optional().describe("Natural language description of what the buyer wants"),
      location: z.string().optional().describe("Preferred locality"),
      city: z.string().optional().describe("City"),
      asset_type: z.enum(["residential", "commercial", "all"]).optional().default("all"),
      transaction_type: z.enum(["sale", "rent", "all"]).optional().default("all"),
      bhk: z.number().optional().describe("Preferred BHK"),
      budget_min: z.number().optional().describe("Minimum budget in absolute INR"),
      budget_max: z.number().optional().describe("Maximum budget in absolute INR"),
      max_budget_cr: z.number().optional().describe("Compatibility input: maximum budget in crores"),
      limit: z.number().optional().default(8),
    },
  }, async (input) => {
    const id = requireBrokerId(context);
    await logToolCall(id, "requirement_match", input);
    const result = await matchRequirementToInventory({
      requirement_id: input.requirement_id,
      raw_text: input.raw_text,
      locality: input.location,
      city: input.city,
      asset_type: input.asset_type,
      transaction_type: input.transaction_type,
      bhk: input.bhk,
      budget_min: input.budget_min,
      budget_max: input.budget_max,
      max_budget_cr: input.max_budget_cr,
      limit: input.limit,
    });
    return textResponse(
      result.items.length
        ? result.items.map((item, index) => `${index + 1}. ${item.title} — ${item.locality || "location not specified"} — ${item.price ?? "price on request"} — score ${item.score}`).join("\n")
        : "No matching listings found for this requirement.",
      result,
    );
  });

  server.registerTool("requirement_timeline", {
    description: "Track the timeline of a requirement — when it was posted, last active, status changes",
    inputSchema: {
      requirement_id: z.string().describe("The requirement ID to look up"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "requirement_timeline", input);
    return textResponse(`Timeline for requirement ${input.requirement_id}`, {
      requirement_id: input.requirement_id,
    });
  });
}
