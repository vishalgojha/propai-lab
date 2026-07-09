import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall } from "../data.ts";
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
    description: "Search for buyer/tenant requirements in the market by location, budget, and BHK preference",
    inputSchema: {
      location: z.string().optional().describe("Locality or area (e.g. 'Bandra West', 'Powai')"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      bhk: z.number().optional().describe("Minimum BHK preference"),
      max_budget_cr: z.number().optional().describe("Maximum budget in crores"),
      limit: z.number().optional().default(10),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "requirement_search", input);
    return textResponse("Search requirements using market_search or from workspace saved requirements.", { filters: input });
  });

  server.registerTool("requirement_match", {
    description: "Find the best matching inventory (listings) for a buyer/tenant requirement",
    inputSchema: {
      raw_text: z.string().optional().describe("Natural language description of what the buyer wants"),
      location: z.string().optional().describe("Preferred locality"),
      city: z.string().optional().describe("City"),
      bhk: z.number().optional().describe("Preferred BHK"),
      max_budget_cr: z.number().optional().describe("Maximum budget in crores"),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional().default("sale"),
      limit: z.number().optional().default(8),
    },
  }, async (input) => {
    const id = requireBrokerId(context);
    await logToolCall(id, "requirement_match", input);
    return textResponse("Use market_search with requirement intent to find matching inventory. Full match requires workspace listing access.", { filters: input });
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
