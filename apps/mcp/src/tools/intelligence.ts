import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getMarketSummary, getBuildingIntel, logToolCall } from "../data.ts";
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

export function registerIntelligenceTools(server: McpServer, context: ToolContext) {
  server.registerTool("intel_ask", {
    description: "Ask a question about the real estate market — combines market data, building intel, and analysis",
    inputSchema: {
      question: z.string().describe("Your question. Examples: 'What's happening in Bandra West?', 'How is the market in Powai?'"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "intel_ask", input);
    const query = input.question.toLowerCase();
    const locationMatch = query.match(/in\s+([a-z\s]+?)(?:\s+(under|between|over|above|below|for|\d)|$)/i);
    const location = locationMatch?.[1]?.trim();
    const summary = location ? await getMarketSummary({ locality: location, days: 90 }) : null;
    const parts = [`Analysis for: "${input.question}"`];
    if (summary) parts.push(`${location}: ${summary.listing_count} listings, avg sale ${formatCurrencyCr(summary.avg_price_cr)}`);
    return textResponse(parts.join("\n"), { question: input.question, market_data: summary });
  });

  server.registerTool("intel_explain", {
    description: "Explain a market trend or topic with supporting data",
    inputSchema: {
      topic: z.string().describe("What to explain (e.g. 'supply and demand in Powai', 'price trends in Bandra')"),
      location: z.string().optional().describe("Optional location context"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "intel_explain", input);
    const summary = input.location ? await getMarketSummary({ locality: input.location, days: 90 }) : null;
    const ctx = summary ? `${input.location}: ${summary.listing_count} listings, avg sale ${formatCurrencyCr(summary.avg_price_cr)} over 90d` : "";
    return textResponse(`Explaining: ${input.topic}\n${ctx}`, { topic: input.topic, market_data: summary });
  });

  server.registerTool("intel_compare", {
    description: "Compare two localities or buildings side by side",
    inputSchema: {
      entity_a: z.string().describe("First entity (locality or building)"),
      entity_b: z.string().describe("Second entity"),
      type: z.enum(["locality", "building"]).optional().default("locality"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "intel_compare", input);
    const [a, b] = await Promise.all([
      input.type === "building"
        ? getBuildingIntel({ building_name: input.entity_a, days_back: 90 })
        : getMarketSummary({ locality: input.entity_a, days: 90 }),
      input.type === "building"
        ? getBuildingIntel({ building_name: input.entity_b, days_back: 90 })
        : getMarketSummary({ locality: input.entity_b, days: 90 }),
    ]);
    const fmt = (x: any) => input.type === "building"
      ? `${x.building_name || "N/A"}: ${x.matched_localities?.join(", ") || "N/A"}`
      : `${x.listing_count} listings, avg sale ${formatCurrencyCr(x.avg_price_cr)}`;
    return textResponse(`Comparison: ${input.entity_a} vs ${input.entity_b}\nA: ${fmt(a)}\nB: ${fmt(b)}`, { a, b });
  });
}
