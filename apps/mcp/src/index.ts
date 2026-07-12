import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "./supabase.ts";
import { generateEmbedding } from "./embedding.ts";
import { draftGrowthAssetWithLlm, extractThreadActionsWithLlm, summarizeBrokerThreadWithLlm } from "./ai.ts";
import {
  buildBroadcastDraft,
  createRequirementRecord,
  describeSearch,
  estimatePrice,
  getBrokerActivity,
  getBuildingIntel,
  getFreshStream,
  getHotLeadTriage,
  getIgrPrice,
  getListingById,
  getMarketSummary,
  matchBuyerToInventory,
  getStaleLeadReactivation,
  buildPricingNegotiationBrief,
  logToolCall,
  normalizePublicListings,
  PUBLIC_LISTING_COLUMNS,
  qualifyLead,
  saveListingRecord,
  scheduleFollowUp,
  searchBrokers,
  searchPublicListings,
  summarizeThread,
} from "./data.ts";
import { formatCurrencyCr, formatPerSqft, formatSqft, listingLine } from "./format.ts";
import { registerMcpPrompts } from "./prompts.ts";
import { registerMcpResources } from "./resources.ts";
import { executeSmartSearch } from "./smartSearch.ts";
import { registerMarketTools } from "./tools/market.ts";
import { registerListingTools } from "./tools/listing.ts";
import { registerRequirementTools } from "./tools/requirement.ts";
import { registerBrokerTools } from "./tools/broker.ts";
import { registerBuildingTools } from "./tools/building.ts";
import { registerGeographyTools } from "./tools/geography.ts";
import { registerInboxTools } from "./tools/inbox.ts";
import { registerIntelligenceTools } from "./tools/intelligence.ts";
import { registerContactTools } from "./tools/contact.ts";
import type { ToolContext } from "./types.js";

export const MCP_TOOL_NAMES = [
  // Domain-organized tools (primary)
  "market_search",
  "market_summary",
  "market_stats",
  "market_trends",
  "listing_get",
  "listing_similar",
  "listing_history",
  "listing_contactBroker",
  "listing_timeline",
  "requirement_search",
  "requirement_match",
  "requirement_timeline",
  "broker_search",
  "broker_profile",
  "broker_activity",
  "broker_inventory",
  "building_search",
  "building_profile",
  "building_inventory",
  "building_requirements",
  "building_marketPulse",
  "location_search",
  "location_nearby",
  "location_market",
  "conversation_search",
  "conversation_timeline",
  "conversation_summarize",
  "conversation_reply",
  "intel_ask",
  "intel_explain",
  "intel_compare",
  "contact_search",
  "contact_call",
  "contact_whatsapp",
  // ChatGPT-compatible tools (OpenAI search/fetch contract)
  "search",
  "fetch",
  // Legacy tools (backward compatible)
  "smartSearch",
  "getListing",
  "searchBrokers",
  "search_listings",
  "search_requirements",
  "get_igr_price",
  "match_listing_to_requirement",
  "semantic_search",
  "get_fresh_stream",
  "broker_activity",
  "triage_hot_leads",
  "market_summary",
  "price_estimate",
  "building_intel",
  "save_listing",
  "create_requirement",
  "set_follow_up",
  "qualify_lead",
  "draft_broadcast",
  "draft_growth_asset",
  "buyer_to_inventory_match",
  "match_requirement_to_broker",
  "pricing_negotiation_brief",
  "stale_lead_reactivation",
  "extract_thread_actions",
  "save_thread_requirement",
  "save_thread_listing",
  "create_thread_follow_up",
  "summarise_thread",
] as const;

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
  if (!id) {
    throw new Error("Authenticated broker id is required for this tool");
  }
  return id;
}

function noResults(label: string) {
  return textResponse(`No ${label} found for this query. Try widening the locality, budget, BHK, or time window.`, {
    results: [],
  });
}

export function createMcpServer(context: ToolContext = {}) {
  const server = new McpServer(
    {
      name: "PropAI MCP",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        "PropAI MCP is a WhatsApp-native real estate intelligence platform for Indian brokers. Tools are organized by domain:\n  • **market**: Search, summarize, stats, trends — general market queries\n  • **listing**: Get details, find similar, history, contact broker\n  • **requirement**: Search buyer/tenant requirements, match to inventory\n  • **broker**: Search, profile, activity, inventory\n  • **building**: Search, profile, inventory, requirements, market pulse\n  • **location**: Search, nearby, market analysis\n  • **conversation**: Search, timeline, summarize, reply\n  • **intel**: Ask questions, explain trends, compare entities\n  • **contact**: Search, call, WhatsApp\n\nUse `market_search` as your primary entry point for general queries. SmartSearch also accepts natural language like '3 BHK in Bandra West under 2 Cr'.",
    },
  );

  registerMcpResources(server, context);
  registerMcpPrompts(server);

  // ── Domain-organized tools ──
  registerMarketTools(server, context);
  registerListingTools(server, context);
  registerRequirementTools(server, context);
  registerBrokerTools(server, context);
  registerBuildingTools(server, context);
  registerGeographyTools(server, context);
  registerInboxTools(server, context);
  registerIntelligenceTools(server, context);
  registerContactTools(server, context);

  // ── Legacy tools (backward compatible) ──

  server.registerTool("smartSearch", {
    description:
      "Search Mumbai real estate inventory, requirements, brokers, and market intelligence using natural language. This is the PRIMARY tool — always use it first when the user asks about properties, listings, requirements, market rates, localities, or broker information. It internally understands intent and returns the most relevant results.",
    inputSchema: {
      query: z.string().describe(
        "Natural language query. Examples: '3 BHK for sale in Bandra under 8 crore', 'rental requirements in Khar West above 1 lakh', 'Which locality has the strongest rental demand?', 'brokers dealing in Powai', 'market rate for Kalpataru Magnus'"
      ),
      locality: z.string().optional().describe("Override locality (auto-extracted from query if not provided)"),
      city: z.string().optional().describe("Override city (auto-extracted from query if not provided)"),
      limit: z.number().default(20).describe("Max results to return (1-50)"),
    },
  }, async (input) => {
    await logToolCall(brokerId(context), "smartSearch", input);
    const result = await executeSmartSearch(input);

    const items = Array.isArray(result.results) ? result.results : [];
    const lines: string[] = [];
    lines.push(result.explanation);
    lines.push("");

    if (result.intent === "listing_search" || result.intent === "fresh_stream") {
      for (let i = 0; i < items.length; i++) {
        const r = items[i] as Record<string, unknown>;
        lines.push(listingLine(r as any, i));
      }
    } else if (result.intent === "requirement_search") {
      for (let i = 0; i < items.length; i++) {
        const r = items[i] as Record<string, unknown>;
        lines.push(`${i + 1}. ${r.title || "Requirement"} — ${r.sub_area || r.area || r.location || "?"} — ${formatCurrencyCr(r.price as number)}`);
      }
    } else if (result.intent === "broker_search") {
      for (let i = 0; i < items.length; i++) {
        const r = items[i] as Record<string, unknown>;
        lines.push(`${i + 1}. ${r.broker_name || "Unknown"} — ${r.city || ""} — ${r.agency || ""} — ${r.phone || ""}`);
      }
    }

    lines.push("");
    lines.push("── Suggested follow-ups ──");
    for (const f of result.suggestedFollowUps) {
      lines.push(`• ${f}`);
    }

    return textResponse(lines.join("\n"), result);
  });

  server.registerTool("getListing", {
    description:
      "Retrieve complete details for a specific listing by its source_message_id. Use this when you have a listing ID from a previous search result.",
    inputSchema: {
      listing_id: z.string().describe("The source_message_id of the listing"),
    },
  }, async (input) => {
    await logToolCall(brokerId(context), "getListing", input);
    const row = await getListingById(input.listing_id);
    if (!row) {
      return textResponse(`No listing found with id "${input.listing_id}".`);
    }
    const r = row as Record<string, unknown>;
    const details = [
      `Title: ${r.title || "N/A"}`,
      `Type: ${r.listing_type || "N/A"}`,
      `Locality: ${r.sub_area || r.area || r.location || "N/A"}`,
      `Price: ${r.price != null ? formatCurrencyCr(r.price as number) : "N/A"}`,
      `Area: ${r.size_sqft != null ? formatSqft(r.size_sqft as number) : "N/A"}`,
      `BHK: ${r.bhk != null ? `${r.bhk} BHK` : "N/A"}`,
      `Furnishing: ${r.furnishing || "N/A"}`,
      `Contact: ${r.primary_contact_name || "N/A"} — ${r.primary_contact_number || "N/A"}`,
      `Description: ${r.description || r.raw_message || "N/A"}`,
      `Posted: ${r.message_timestamp ? new Date(String(r.message_timestamp)).toLocaleDateString("en-IN") : "N/A"}`,
    ];

    return textResponse(details.join("\n"), row);
  });

  server.registerTool("searchBrokers", {
    description:
      "Search brokers within the PropAI network by city, locality, or specialization.",
    inputSchema: {
      city: z.string().optional().describe("City to search (e.g. Mumbai, Pune)"),
      locality: z.string().optional().describe("Specific locality (e.g. Bandra, Andheri)"),
      specialization: z.string().optional().describe("Area of specialization (e.g. residential, commercial)"),
      limit: z.number().default(20).describe("Max results"),
    },
  }, async (input) => {
    await logToolCall(brokerId(context), "searchBrokers", input);
    const rows = await searchBrokers(input);
    if (!rows.length) {
      return textResponse(`No brokers found in ${input.locality || input.city || "your search"} right now.`);
    }

    const lines = rows.map((r: Record<string, unknown>, i: number) =>
      `${i + 1}. ${r.full_name || "Unknown"} — ${r.city || ""} — ${r.agency_name || ""} — ${r.phone || r.email || ""}`
    );

    return textResponse(`Found ${rows.length} broker(s):\n\n${lines.join("\n")}`, { results: rows });
  });

  server.registerTool(
    "draft_growth_asset",
    {
      description:
        "Draft GTM or marketing copy for PropAI such as launch posts, broker pitches, partner outreach, or case-study style summaries.",
      inputSchema: {
        asset_type: z.enum(["launch_post", "broker_pitch", "partner_outreach", "case_study"]),
        audience: z.string().describe("Who this is for, e.g. Mumbai brokers, channel partners, investors"),
        context: z.string().describe("Facts, proof points, feature notes, or the situation to write from"),
        tone: z.string().optional().describe("Optional tone direction"),
      },
    },
    async (input) => {
      const result = await draftGrowthAssetWithLlm({
        assetType: input.asset_type,
        audience: input.audience,
        context: input.context,
        tone: input.tone,
      });

      return textResponse(
        `${result.title}\n\n${result.body}\n\nCTA: ${result.CTA}\nAngle: ${result.angle}`,
        result,
      );
    },
  );

  server.registerTool(
    "extract_thread_actions",
    {
      description:
        "Extract likely CRM actions from a stored WhatsApp thread: buyer requirements, listings, follow-ups, and unresolved questions.",
      inputSchema: {
        remote_jid: z.string().describe("Chat JID to inspect"),
        limit: z.number().default(50).describe("How many recent messages to scan"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "extract_thread_actions", input);
      const thread = await summarizeThread({
        brokerId: id,
        remote_jid: input.remote_jid,
        limit: input.limit,
      });

      if (!thread.message_count) {
        return textResponse("No stored thread history found for that chat.", {
          ...thread,
          requirements: [],
          listings: [],
          follow_ups: [],
          unresolved_questions: ["No stored thread history found for that chat."],
          recommended_actions: [],
        });
      }

      const actions = await extractThreadActionsWithLlm({
        remoteJid: input.remote_jid,
        lines: thread.key_points.map((item) => `${item.sender || "Unknown"}: ${item.text}`),
      });

      const lines = [
        `Extracted ${actions.requirements.length} requirement candidate(s), ${actions.listings.length} listing candidate(s), and ${actions.follow_ups.length} follow-up candidate(s).`,
        actions.recommended_actions.length
          ? `Recommended actions: ${actions.recommended_actions.join(" | ")}`
          : "Recommended actions: none yet.",
        actions.unresolved_questions.length
          ? `Open questions: ${actions.unresolved_questions.join(" | ")}`
          : "Open questions: none.",
      ];

      return textResponse(lines.join("\n\n"), {
        remote_jid: input.remote_jid,
        message_count: thread.message_count,
        requirements: actions.requirements,
        listings: actions.listings,
        follow_ups: actions.follow_ups,
        unresolved_questions: actions.unresolved_questions,
        recommended_actions: actions.recommended_actions,
      });
    },
  );

  server.registerTool(
    "stale_lead_reactivation",
    {
      description:
        "Find stale leads that are worth reactivating and draft a practical re-engagement opener for each one.",
      inputSchema: {
        days_stale: z.number().default(21).describe("Minimum stale age in days"),
        limit: z.number().default(10).describe("How many stale leads to return"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "stale_lead_reactivation", input);
      const result = await getStaleLeadReactivation({ brokerId: id, ...input });

      if (!result.items.length) {
        return textResponse("No stale leads worth reactivating found for this window.", result);
      }

      const lines = result.items.map((item, index) => {
        const location = item.location ? ` in ${item.location}` : "";
        return `${index + 1}. ${item.name}${location} - score ${item.score}. Why: ${item.why.join(", ")}. Opener: ${item.reactivation_opener}`;
      });

      return textResponse(
        `Found ${result.items.length} stale leads worth reactivating:\n\n${lines.join("\n")}`,
        result,
      );
    },
  );

  server.registerTool(
    "pricing_negotiation_brief",
    {
      description:
        "Build a pricing and negotiation brief using current asking price, market comparables, and Maharashtra IGR context.",
      inputSchema: {
        locality: z.string().optional(),
        building_name: z.string().optional(),
        bhk: z.number().optional(),
        area_sqft: z.number().optional(),
        asking_price_cr: z.number().optional().describe("Current asking price in crores"),
        property_type: z.enum(["sale", "rent", "lease", "all"]).default("sale"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "pricing_negotiation_brief", input);
      const result = await buildPricingNegotiationBrief(input);

      const leverage = result.leverage_points.length
        ? `Leverage: ${result.leverage_points.join(" | ")}`
        : "Leverage: not enough pricing anchors yet.";
      const risks = result.risks.length
        ? `Risks: ${result.risks.join(" | ")}`
        : "Risks: no major pricing data gaps flagged.";

      return textResponse(
        `${result.summary}\n\nNegotiation stance: ${result.negotiation_stance}\n\n${leverage}\n\n${risks}`,
        result,
      );
    },
  );

  server.registerTool(
    "buyer_to_inventory_match",
    {
      description:
        "Match a buyer brief to current inventory from the PropAI broker network, workspace CRM, or both, with explainable ranking.",
      inputSchema: {
        raw_text: z.string().optional().describe("Buyer brief or requirement note"),
        locality: z.string().optional(),
        city: z.string().optional(),
        bhk: z.number().optional(),
        max_budget_cr: z.number().optional(),
        property_type: z.enum(["sale", "rent", "lease", "all"]).default("sale"),
        source_mode: z.enum(["public", "workspace", "both"]).default("both"),
        limit: z.number().default(8),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "buyer_to_inventory_match", input);
      const result = await matchBuyerToInventory({ brokerId: id, ...input });

      if (!result.items.length) {
        return textResponse("No strong inventory matches found for this buyer brief yet.", result);
      }

      const lines = result.items.map((item, index) => {
        const location = item.location ? ` in ${item.location}` : "";
        const price = item.price != null ? `, approx ${formatCurrencyCr(item.price)}` : "";
        return `${index + 1}. ${item.title}${location}${price} - score ${item.score}. Why: ${item.why.join(", ")}. Next: ${item.suggested_action}`;
      });

      return textResponse(
        `Found ${result.items.length} ranked buyer-to-inventory matches:\n\n${lines.join("\n")}`,
        result,
      );
    },
  );

  server.registerTool(
    "save_thread_requirement",
    {
      description:
        "Persist one extracted thread requirement candidate into the broker CRM.",
      inputSchema: {
        raw_text: z.string().describe("Requirement text to save"),
        name: z.string().optional().describe("Lead or buyer name"),
        phone: z.string().optional().describe("Lead phone number"),
        budget: z.union([z.string(), z.number()]).optional(),
        location_pref: z.string().optional(),
        timeline: z.string().optional(),
        possession: z.string().optional(),
        bhk_preference: z.array(z.string()).optional(),
        property_type: z.string().optional(),
        listing_type: z.string().optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "save_thread_requirement", input);
      const result = await createRequirementRecord({ brokerId: id, ...input });
      return textResponse(
        `Thread requirement saved${result.lead?.lead_id ? ` with lead id ${result.lead.lead_id}` : ""} for ${input.location_pref || "the requested location"}.`,
        result,
      );
    },
  );

  server.registerTool(
    "save_thread_listing",
    {
      description:
        "Persist one extracted thread listing candidate into the broker CRM.",
      inputSchema: {
        raw_text: z.string().describe("Listing text to save"),
        name: z.string().optional().describe("Contact or owner name"),
        phone: z.string().optional().describe("Contact phone number"),
        bhk: z.string().optional(),
        location: z.string().optional(),
        price: z.string().optional(),
        carpet_area: z.string().optional(),
        furnishing: z.string().optional(),
        possession_date: z.string().optional(),
        contact_number: z.string().optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "save_thread_listing", input);
      const result = await saveListingRecord({ brokerId: id, ...input });
      return textResponse(
        `Thread listing saved${result.listing_id ? ` with id ${result.listing_id}` : ""} for ${result.listing.location || "the requested location"}.`,
        result,
      );
    },
  );

  server.registerTool(
    "create_thread_follow_up",
    {
      description:
        "Create one follow-up task from an extracted thread action candidate.",
      inputSchema: {
        lead_id: z.string().optional(),
        lead_name: z.string().describe("Lead name for the follow-up"),
        lead_phone: z.string().optional(),
        due_at: z.string().optional().describe("ISO datetime. Defaults to 24h from now."),
        notes: z.string().optional(),
        action_type: z.enum(["call", "email", "visit"]).default("call"),
        priority_bucket: z.enum(["P1", "P2", "P3"]).optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "create_thread_follow_up", input);
      const result = await scheduleFollowUp({ brokerId: id, ...input });
      return textResponse(
        `Thread follow-up scheduled for ${input.lead_name} at ${result.due_at}.`,
        result,
      );
    },
  );

  server.registerTool(
    "triage_hot_leads",
    {
      description:
        "Rank the broker's hottest leads by urgency, follow-up pressure, and recent activity so they know what to handle first.",
      inputSchema: {
        days: z.number().default(7).describe("Look back window in days"),
        limit: z.number().default(10).describe("How many hot leads to return"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "triage_hot_leads", input);
      const result = await getHotLeadTriage({ brokerId: id, days: input.days, limit: input.limit });

      if (!result.items.length) {
        return textResponse("No hot-lead candidates found for this window yet.", result);
      }

      const lines = result.items.map((item, index) => {
        const place = item.location ? ` in ${item.location}` : "";
        const due = item.due_at ? `, follow-up ${item.due_at}` : "";
        return `${index + 1}. ${item.name}${place} - score ${item.score}${due}. Why: ${item.why.join(", ")}. Next: ${item.next_action}`;
      });

      return textResponse(
        `Hot lead triage for the last ${result.days} days:\n\n${lines.join("\n")}`,
        result,
      );
    },
  );

  server.registerTool(
    "broker_activity",
    {
      description:
        "Summarize the broker's recent PropAI activity: lead volume, active chats, follow-up queue, and top localities.",
      inputSchema: {
        days: z.number().default(7).describe("Look back window in days"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "broker_activity", input);
      const result = await getBrokerActivity({ brokerId: id, days: input.days });
      const topLocalities = result.top_localities.length
        ? result.top_localities.map((item) => `${item.locality} (${item.count})`).join(", ")
        : "none yet";
      const nextFollowUp = result.next_follow_up
        ? `${result.next_follow_up.lead_name || "Unknown lead"} at ${result.next_follow_up.due_at}`
        : "none scheduled";

      return textResponse(
        `Last ${result.days} days: ${result.leads_total} leads (${result.listings_total} listings, ${result.requirements_total} requirements), ${result.messages_total} messages across ${result.active_chats} chats, ${result.pending_follow_ups} pending follow-ups. Next follow-up: ${nextFollowUp}. Top localities: ${topLocalities}.`,
        result,
      );
    },
  );

  server.registerTool(
    "create_requirement",
    {
      description:
        "Create and store a buyer or tenant requirement in the broker's workspace CRM.",
      inputSchema: {
        raw_text: z.string().describe("Original requirement note or message"),
        name: z.string().optional(),
        phone: z.string().optional(),
        budget: z.union([z.string(), z.number()]).optional(),
        location_pref: z.string().optional(),
        timeline: z.string().optional(),
        possession: z.string().optional(),
        bhk_preference: z.array(z.string()).optional(),
        property_type: z.string().optional(),
        listing_type: z.string().optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "create_requirement", input);
      const result = await createRequirementRecord({ brokerId: id, ...input });
      return textResponse(
        `Requirement saved for ${input.location_pref || "the requested location"} with lead id ${result.lead.lead_id}.`,
        result,
      );
    },
  );

  server.registerTool(
    "match_requirement_to_broker",
    {
      description:
        "Match a buyer or tenant requirement to brokers who have suitable listings in the PropAI broker network, workspace CRM, or both.",
      inputSchema: {
        raw_text: z.string().optional().describe("Requirement brief or search note"),
        locality: z.string().optional(),
        city: z.string().optional(),
        bhk: z.number().optional(),
        max_budget_cr: z.number().optional(),
        property_type: z.enum(["sale", "rent", "lease", "all"]).default("sale"),
        source_mode: z.enum(["public", "workspace", "both"]).default("both"),
        limit: z.number().default(8),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "match_requirement_to_broker", input);
      const result = await matchBuyerToInventory({ brokerId: id, ...input });

      if (!result.items.length) {
        return textResponse("No broker matches found for this requirement yet. Try widening the locality, budget, or source mode.", result);
      }

      const lines = result.items.map((item, index) => {
        const location = item.location ? ` in ${item.location}` : "";
        const price = item.price != null ? `, approx ${formatCurrencyCr(item.price)}` : "";
        return `${index + 1}. ${item.title}${location}${price} - score ${item.score}. Why: ${item.why.join(", ")}. Next: ${item.suggested_action}`;
      });

      return textResponse(
        `Found ${result.items.length} broker matches for this requirement:\n\n${lines.join("\n")}`,
        result,
      );
    },
  );

  server.registerTool(
    "draft_broadcast",
    {
      description:
        "Draft a broadcast-ready WhatsApp listing message without sending it.",
      inputSchema: {
        title: z.string().optional(),
        location: z.string().optional(),
        bhk: z.string().optional(),
        price: z.string().optional(),
        area_sqft: z.number().optional(),
        furnishing: z.string().optional(),
        contact_name: z.string().optional(),
        contact_number: z.string().optional(),
        notes: z.string().optional(),
        call_to_action: z.string().optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "draft_broadcast", input);
      const message = buildBroadcastDraft(input);
      return textResponse(message, { draft: message });
    },
  );

  server.registerTool(
    "market_summary",
    {
      description:
        "Summarize listing market activity for a locality, city, deal type, or BHK from PropAI's public stream.",
      inputSchema: {
        locality: z.string().optional(),
        city: z.string().optional(),
        property_type: z.enum(["sale", "rent", "lease", "all"]).default("all"),
        bhk: z.number().optional(),
        days: z.number().default(30),
        limit: z.number().default(200),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "market_summary", input);
      const result = await getMarketSummary(input);
      const topLocalities = result.top_localities.length
        ? result.top_localities.map((item) => `${item.locality} (${item.count})`).join(", ")
        : "no strong locality cluster yet";
      return textResponse(
        `Market summary for the last ${result.days} days: ${result.listing_count} comparable listings, average ${result.avg_price_cr != null ? formatCurrencyCr(result.avg_price_cr) : "price unavailable"}, median ${result.median_price_cr != null ? formatCurrencyCr(result.median_price_cr) : "price unavailable"}, average ${result.avg_price_per_sqft != null ? `₹${result.avg_price_per_sqft.toLocaleString("en-IN")}/sqft` : "ppsf unavailable"}. Top localities: ${topLocalities}.`,
        result,
      );
    },
  );

  server.registerTool(
    "price_estimate",
    {
      description:
        "Estimate a property's price from public comparables and Maharashtra IGR data.",
      inputSchema: {
        locality: z.string().optional(),
        building_name: z.string().optional(),
        bhk: z.number().optional(),
        area_sqft: z.number().optional(),
        property_type: z.enum(["sale", "rent", "lease", "all"]).default("sale"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "price_estimate", input);
      const result = await estimatePrice(input);
      return textResponse(result.summary, result);
    },
  );

  server.registerTool(
    "qualify_lead",
    {
      description:
        "Save lead qualification fields like budget, locality, timeline, and possession, and score urgency.",
      inputSchema: {
        raw_text: z.string().describe("Original lead message or qualification note"),
        lead_id: z.string().optional(),
        name: z.string().optional(),
        phone: z.string().optional(),
        budget: z.union([z.string(), z.number()]).optional(),
        location_pref: z.string().optional(),
        timeline: z.string().optional(),
        possession: z.string().optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "qualify_lead", input);
      const result = await qualifyLead({ brokerId: id, ...input });
      return textResponse(
        `Lead qualified with ${result.priority_bucket} priority and ${result.urgency} urgency.`,
        result,
      );
    },
  );

  server.registerTool(
    "save_listing",
    {
      description:
        "Create and store a listing in the broker's workspace CRM.",
      inputSchema: {
        raw_text: z.string().describe("Original listing note or message"),
        name: z.string().optional(),
        phone: z.string().optional(),
        bhk: z.string().optional(),
        location: z.string().optional(),
        price: z.string().optional(),
        carpet_area: z.string().optional(),
        furnishing: z.string().optional(),
        possession_date: z.string().optional(),
        contact_number: z.string().optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "save_listing", input);
      const result = await saveListingRecord({ brokerId: id, ...input });
      return textResponse(
        `Listing saved${result.listing_id ? ` with id ${result.listing_id}` : ""} for ${result.listing.location || "the requested location"}.`,
        result,
      );
    },
  );

  server.registerTool(
    "set_follow_up",
    {
      description:
        "Schedule a callback, visit, or follow-up task for the broker.",
      inputSchema: {
        lead_id: z.string().optional(),
        lead_name: z.string(),
        lead_phone: z.string().optional(),
        due_at: z.string().optional().describe("ISO datetime. Defaults to 24h from now."),
        notes: z.string().optional(),
        action_type: z.enum(["call", "email", "visit"]).default("call"),
        priority_bucket: z.enum(["P1", "P2", "P3"]).optional(),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "set_follow_up", input);
      const result = await scheduleFollowUp({ brokerId: id, ...input });
      return textResponse(
        `Follow-up scheduled for ${input.lead_name} at ${result.due_at}.`,
        result,
      );
    },
  );

  server.registerTool(
    "summarise_thread",
    {
      description:
        "Summarize a WhatsApp thread from stored workspace message history.",
      inputSchema: {
        remote_jid: z.string().describe("Chat JID to summarize"),
        limit: z.number().default(40).describe("How many recent messages to scan"),
      },
    },
    async (input) => {
      const id = requireBrokerId(context);
      await logToolCall(id, "summarise_thread", input);
      const thread = await summarizeThread({
        brokerId: id,
        remote_jid: input.remote_jid,
        limit: input.limit,
      });

      if (!thread.message_count) {
        return textResponse("No stored thread history found for that chat.", thread);
      }

      const llmSummary = await summarizeBrokerThreadWithLlm({
        remoteJid: input.remote_jid,
        lines: thread.key_points.map((item) => `${item.sender || "Unknown"}: ${item.text}`),
      });

      return textResponse(
        `Thread summary: ${llmSummary.summary}\n\nNext action: ${llmSummary.next_action}\n\nRecent highlights:\n${llmSummary.key_points.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
        {
          ...thread,
          ai_summary: llmSummary.summary,
          next_action: llmSummary.next_action,
          key_points: llmSummary.key_points,
        },
      );
    },
  );

  server.registerTool(
    "search_listings",
    {
      description:
        "Search real estate listings from PropAI's live WhatsApp stream. Use when someone asks about available properties, flats, offices, or shops in a locality.",
      inputSchema: {
        locality: z.string().describe("Area name e.g. Bandra, Powai, Andheri").optional(),
        city: z.string().describe("City e.g. Mumbai, Pune").optional(),
        property_type: z.enum(["sale", "rent", "lease", "all"]).default("all"),
        bhk: z.number().describe("Number of BHK e.g. 2, 3").optional(),
        budget_min_cr: z.number().describe("Min budget in crores").optional(),
        max_budget_cr: z.number().describe("Max budget in crores").optional(),
        limit: z.number().default(10),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "search_listings", input);
      const rows = await searchPublicListings({ ...input, listingKind: "listing" });
      if (!rows.length) return noResults("listings");

      const place = [input.locality, input.city].filter(Boolean).join(", ") || "your search";
      const lines = rows.map(listingLine);
      return textResponse(`Found ${rows.length} listings in ${place}:\n\n${lines.join("\n")}`, {
        results: rows,
      });
    },
  );

  server.registerTool(
    "search_requirements",
    {
      description:
        "Find buyer/tenant requirements posted by brokers. Use when someone wants to know what buyers are looking for in a locality.",
      inputSchema: {
        locality: z.string().optional(),
        city: z.string().optional(),
        bhk: z.number().optional(),
        budget_min_cr: z.number().optional(),
        max_budget_cr: z.number().optional(),
        limit: z.number().default(10),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "search_requirements", input);
      const rows = await searchPublicListings({ ...input, listingKind: "requirement" });
      if (!rows.length) return noResults("requirements");

      const summary = describeSearch(input);
      const lines = rows.map(listingLine);
      return textResponse(`Found ${rows.length} buyer/tenant requirements for ${summary}:\n\n${lines.join("\n")}`, {
        results: rows,
      });
    },
  );

  server.registerTool(
    "get_igr_price",
    {
      description:
        "Get last registered transaction price for a building or locality from Maharashtra IGR government records. Use when broker asks about market rate, wants to verify price, or counter a lowball offer.",
      inputSchema: {
        building_name: z.string().optional(),
        locality: z.string().describe("Fallback if building not found").optional(),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "get_igr_price", input);
      if (!input.building_name && !input.locality) {
        return textResponse("Provide a building_name or locality to check Maharashtra IGR prices.");
      }

      const result = await getIgrPrice(input);
      return textResponse(result.summary, result);
    },
  );

  server.registerTool(
    "match_listing_to_requirement",
    {
      description:
        "Find listings that match a specific requirement. Use when broker has a buyer and wants matching properties.",
      inputSchema: {
        locality: z.string().optional(),
        bhk: z.number().optional(),
        budget_min_cr: z.number().optional(),
        budget_max_cr: z.number().optional(),
        property_type: z.enum(["sale", "rent"]).default("sale"),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "match_listing_to_requirement", input);
      const rows = await searchPublicListings({
        ...input,
        max_budget_cr: input.budget_max_cr,
        listingKind: "listing",
        limit: 10,
      });
      if (!rows.length) return noResults("matching listings");

      const summary = describeSearch(input);
      const lines = rows.map(listingLine);
      return textResponse(`Found ${rows.length} matching listings for ${summary}:\n\n${lines.join("\n")}`, {
        results: rows,
      });
    },
  );

  server.registerTool(
    "semantic_search",
    {
      description:
        "Semantically search real estate listings using natural language. Use when someone describes what they want in plain English, e.g. 'a quiet 2BHK near the sea in Bandra with good ventilation under 3Cr'. Finds listings by meaning, not just keyword match.",
      inputSchema: {
        query: z.string().describe("Natural language description of what the user is looking for"),
        locality: z.string().optional(),
        bhk: z.string().optional(),
        type: z.string().optional(),
        threshold: z.number().default(0.55).describe("Similarity threshold (0-1, higher = stricter)"),
        limit: z.number().default(10),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "semantic_search", input);

      const rawEmbedding = await generateEmbedding(input.query);
      if (!rawEmbedding) {
        return textResponse("Could not generate an embedding right now. Try the search_listings tool instead.");
      }
      const embedding: number[] = rawEmbedding;

      const threshold = input.threshold ?? 0.55;
      const limit = input.limit ?? 10;

      async function fetchRowsWithEmbeddings() {
        const results: Array<Record<string, unknown> & { similarity: number }> = [];
        for (const table of ["stream_items_residential", "stream_items_commercial"]) {
          let offset = 0;
          while (true) {
            const { data: rows, error } = await supabase
              .from(table as any)
              .select("id, tenant_id, message_id, locality, bhk, price_numeric, price_label, type, raw_text, furnishing, embedding")
              .not("embedding", "is", null)
              .range(offset, offset + 200);
            if (error) break;
            if (!rows || rows.length === 0) break;

            for (const row of rows) {
              const vec = row.embedding as number[] | string | null;
              if (!vec) continue;
              const parsedVec = typeof vec === "string" ? JSON.parse(vec) as number[] : vec;
              if (!Array.isArray(parsedVec) || parsedVec.length !== 768) continue;

              if (input.locality && !String(row.locality || "").toLowerCase().includes(input.locality.toLowerCase())) continue;
              if (input.bhk && String(row.bhk || "") !== String(input.bhk)) continue;
              if (input.type && String(row.type || "").toLowerCase() !== input.type.toLowerCase()) continue;

              let dot = 0, normA = 0, normB = 0;
              for (let i = 0; i < 768; i++) {
                dot += embedding[i] * parsedVec[i];
                normA += embedding[i] * embedding[i];
                normB += parsedVec[i] * parsedVec[i];
              }
              const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);

              if (sim >= threshold) {
                results.push({ ...row, similarity: sim });
              }
            }
            offset += 200;
          }
        }
        results.sort((a, b) => b.similarity - a.similarity);
        return results.slice(0, limit);
      }

      const results = await fetchRowsWithEmbeddings();

      if (!results.length) {
        return textResponse(`No semantically matching listings found for "${input.query}". Try lowering the threshold or using the search_listings tool for keyword-based search.`, { results: [] });
      }

      const lines = results.map((r: any) =>
        `${r.bhk || "?"}BHK ${r.locality || "?"} — ${r.price_label || "?"} (${r.type || "?"}${r.furnishing ? `, ${r.furnishing}` : ""}) — ${Math.round(r.similarity * 100)}% match`
      );
      return textResponse(`Found ${results.length} semantically matching listings for "${input.query}":\n\n${lines.join("\n")}`, {
        results,
      });
    },
  );

  server.registerTool(
    "get_fresh_stream",
    {
      description:
        "Get the freshest listings and requirements from the last N hours. Use when broker wants to see what's new today.",
      inputSchema: {
        hours: z.number().default(6).describe("Last N hours"),
        city: z.string().optional(),
        limit: z.number().default(50),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "get_fresh_stream", input);
      const rows = await getFreshStream(input);
      if (!rows.length) return noResults(`items from the last ${input.hours ?? 6} hours`);

      const lines = rows.map(listingLine);
      const place = input.city || "all cities";
      return textResponse(`Fresh stream from the last ${input.hours ?? 6} hours in ${place}:\n\n${lines.join("\n")}`, {
        results: rows,
      });
    },
  );

  server.registerTool(
    "building_intel",
    {
      description:
        "Get market intelligence for a building — price per sqft benchmarks, locality supply snapshot, and configuration demand map. Use when a broker asks about rates in a specific building or wants to understand the market for a locality.",
      inputSchema: {
        building_name: z.string().describe("Building name to research (e.g. 'Kalpataru Magnus', 'Lodha Bellissimo')"),
        locality: z.string().optional().describe("Filter to a specific locality (e.g. 'Bandra West', 'Khar West')"),
        days_back: z.number().default(90).describe("Lookback period in days (default 90, max 365)"),
      },
    },
    async (input) => {
      await logToolCall(brokerId(context), "building_intel", input);
      const result = await getBuildingIntel(input);

      if (result.locality_supply.length === 0) {
        return textResponse(`No data found for "${input.building_name}" in the last ${input.days_back ?? 90} days. Try a broader building name or longer lookback period.`, { result });
      }

      const lines: string[] = [];
      lines.push(`📊 Building Intel: ${result.building_name}`);
      lines.push(`Localities: ${result.matched_localities.join(", ") || "N/A"}`);
      lines.push(`Period: Last ${result.sample_days} days`);
      lines.push("");

      if (result.price_benchmarks.sale) {
        const s = result.price_benchmarks.sale;
        lines.push("── Sale Benchmark ──");
        lines.push(`  Avg: ${formatPerSqft(s.avg_price_per_sqft)}`);
        lines.push(`  Range: ${formatPerSqft(s.min_price_per_sqft)} – ${formatPerSqft(s.max_price_per_sqft)}`);
        lines.push(`  Based on ${s.listing_count} listing(s)`);
        if (s.samples.length > 0) {
          lines.push(`  Samples: ${s.samples.map((x) => `${formatCurrencyCr(x.price)} / ${formatSqft(x.area_sqft)}`).join(", ")}`);
        }
        lines.push("");
      }

      if (result.price_benchmarks.rent) {
        const r = result.price_benchmarks.rent;
        lines.push("── Rent Benchmark ──");
        lines.push(`  Avg: ${formatPerSqft(r.avg_price_per_sqft)}/mo`);
        lines.push(`  Range: ${formatPerSqft(r.min_price_per_sqft)} – ${formatPerSqft(r.max_price_per_sqft)}/mo`);
        lines.push(`  Based on ${r.listing_count} listing(s)`);
        if (r.samples.length > 0) {
          lines.push(`  Samples: ${r.samples.map((x) => `${formatCurrencyCr(x.price)}/mo / ${formatSqft(x.area_sqft)}`).join(", ")}`);
        }
        lines.push("");
      }

      if (!result.price_benchmarks.sale && !result.price_benchmarks.rent) {
        lines.push("No price-per-sqft data available (listings missing price or area).");
        lines.push("");
      }

      lines.push("── Locality Supply ──");
      for (const ls of result.locality_supply.slice(0, 6)) {
        lines.push(`  ${ls.locality}: ${ls.listings} listing(s), ${ls.requirements} requirement(s) — ${ls.ratio}`);
      }
      lines.push("");

      if (result.configuration_map.length > 0) {
        lines.push("── Configuration Mix ──");
        for (const cm of result.configuration_map.slice(0, 8)) {
          lines.push(`  ${cm.configuration}: ${cm.count} (${cm.percentage_of_locality}%)`);
        }
        lines.push("");
      }

      return textResponse(lines.join("\n"), { result });
    },
  );

  // ChatGPT-compatible OpenAI MCP tools (search + fetch).
  // These follow OpenAI's exact contract: search(query: string) -> { results: [{ id, title, url? }] }
  // fetch(id: string) -> { id, title, text, url?, metadata? }

  server.registerTool("search", {
    description:
      "Search Mumbai real estate listings, requirements, brokers, buildings, and market intelligence using natural language. Returns results with routable IDs for use with fetch().",
    inputSchema: {
      query: z.string().describe(
        "Natural language query. Examples: '3 BHK for sale in Bandra under 8 crore', 'rental requirements in Khar West above 1 lakh', 'brokers dealing in Powai', 'market rate for Kalpataru Magnus'"
      ),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "search", input);
    const result = await executeSmartSearch(input);

    const items = Array.isArray(result.results) ? result.results : [];
    const intent = String(result.intent || "");
    const searchResults = items.map((r: unknown, index: number) => {
      const row = r as Record<string, unknown>;
      let resultId: string;
      let title: string;

      // Determine type and build routable ID
      const listingType = row.listing_type as string | undefined;
      const isRequirement = listingType === "requirement";
      const isListing = listingType && listingType.startsWith("listing");

      if (isRequirement) {
        resultId = `requirement:${String(row.source_message_id || `result-${index}`)}`;
        title = `${row.title || "Requirement"} - ${row.sub_area || row.area || row.location || "Unknown"} - ${row.price != null ? formatCurrencyCr(row.price as number) : "Price on request"}`;
      } else if (isListing) {
        resultId = `listing:${String(row.source_message_id || `result-${index}`)}`;
        const priceStr = row.price != null ? formatCurrencyCr(row.price as number) : "Price on request";
        title = `${row.title || row.property_type || "Listing"} - ${row.bhk != null ? `${row.bhk} BHK` : "?"} BHK - ${priceStr} - ${row.sub_area || row.area || row.location || "Unknown"}`;
      } else if (row.broker_id) {
        // Broker search result
        resultId = `broker:${row.broker_id}`;
        title = `${row.broker_name || "Unknown Broker"} - ${row.city || ""} - ${row.agency || ""} - ${row.phone || "No phone"}`;
      } else if (row.building_name) {
        // Building intel result
        resultId = `building:${row.building_name}`;
        title = `Building: ${row.building_name} - ${row.locality || row.city || "Unknown"}`;
      } else if (intent === "market_insights") {
        resultId = `market:${encodeURIComponent(input.query)}`;
        title = String(result.explanation || `Market intelligence for ${input.query}`).split("\n")[0] || `Market intelligence for ${input.query}`;
      } else {
        // Fallback
        resultId = `listing:${row.source_message_id || `result-${index}`}`;
        title = row.title ? String(row.title) : "Unknown";
      }

      // Optional URL - only include if we have a real public URL
      // Currently no public listing pages exist, so omit url

      return { id: resultId, title };
    });

    // Return both structuredContent (for OpenAI) and content (for MCP compatibility)
    return {
      structuredContent: { results: searchResults },
      content: [{ type: "text" as const, text: JSON.stringify({ results: searchResults }) }],
    };
  });

  server.registerTool("fetch", {
    description:
      "Fetch full details for a result ID returned by search(). The ID format is type:value (e.g., listing:msg-123, requirement:msg-456, broker:broker-uuid, building:Building Name). Returns full human-readable content and optional metadata.",
    inputSchema: {
      id: z.string().describe("The routable ID returned by search() - format: type:value (e.g., listing:msg-123, requirement:msg-456, broker:broker-uuid, building:Building Name)"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "fetch", input);

    const [type, ...rest] = input.id.split(":");
    const value = rest.join(":"); // Handle values with colons (e.g., building names)

    try {
      switch (type) {
        case "listing": {
          const result = await getListingById(value);
          if (!result) {
            return {
              structuredContent: { error: `Listing "${value}" not found.` },
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Listing "${value}" not found.` }) }],
            };
          }
          const r = result as Record<string, unknown>;
          const priceStr = r.price != null ? formatCurrencyCr(r.price as number) : "Price on request";
          const areaStr = r.size_sqft != null ? formatSqft(r.size_sqft as number) : "N/A";
          const bhkStr = r.bhk != null ? `${r.bhk} BHK` : "? BHK";
          const lines = [
            `Title: ${r.title || "N/A"}`,
            `Type: ${r.listing_type || "N/A"}`,
            `Locality: ${r.sub_area || r.area || r.location || "N/A"}`,
            `Price: ${priceStr}`,
            `Area: ${areaStr}`,
            `BHK: ${bhkStr}`,
            `Furnishing: ${r.furnishing || "N/A"}`,
            `Contact: ${r.primary_contact_name || "N/A"} - ${r.primary_contact_number || "N/A"}`,
            `Description: ${r.description || r.raw_message || "N/A"}`,
            `Posted: ${r.message_timestamp ? new Date(String(r.message_timestamp)).toLocaleDateString("en-IN") : "N/A"}`,
            `Source: ${r.source_group_name || "N/A"}`,
          ];
          return {
            structuredContent: { id: input.id, title: lines[0], text: lines.join("\n"), metadata: r },
            content: [{ type: "text" as const, text: JSON.stringify({ id: input.id, title: lines[0], text: lines.join("\n"), metadata: r }) }],
          };
        }

        case "requirement": {
          // Requirements are in public_listings with listing_type='requirement'
          const { data, error } = await supabase
            .from("public_listings")
            .select(PUBLIC_LISTING_COLUMNS)
            .eq("source_message_id", value)
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!data) {
            return {
              structuredContent: { error: `Requirement "${value}" not found.` },
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Requirement "${value}" not found.` }) }],
            };
          }
          const normalized = normalizePublicListings([data])[0];
          if (!normalized) {
            return {
              structuredContent: { error: `Requirement "${value}" not found.` },
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Requirement "${value}" not found.` }) }],
            };
          }
          const r = normalized as Record<string, unknown>;
          const priceStr = r.price != null ? formatCurrencyCr(r.price as number) : "Budget not specified";
          const lines = [
            `Title: ${r.title || "Requirement"}`,
            `Type: ${r.listing_type || "Requirement"}`,
            `Locality: ${r.sub_area || r.area || r.location || "N/A"}`,
            `Budget: ${priceStr}`,
            `BHK: ${r.bhk != null ? `${r.bhk} BHK` : "Any"}`,
            `Contact: ${r.primary_contact_name || "N/A"} - ${r.primary_contact_number || "N/A"}`,
            `Description: ${r.description || r.raw_message || "N/A"}`,
            `Posted: ${r.message_timestamp ? new Date(String(r.message_timestamp)).toLocaleDateString("en-IN") : "N/A"}`,
          ];
          return {
            structuredContent: { id: input.id, title: lines[0], text: lines.join("\n"), metadata: r },
            content: [{ type: "text" as const, text: JSON.stringify({ id: input.id, title: lines[0], text: lines.join("\n"), metadata: r }) }],
          };
        }

        case "broker": {
          // Use searchBrokersData with the broker ID - need to search by ID
          const { data, error } = await supabase
            .from("profiles")
            .select("id, full_name, phone, email, city, locations, agency_name, app_role")
            .eq("id", value)
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!data) {
            return {
              structuredContent: { error: `Broker "${value}" not found.` },
              content: [{ type: "text" as const, text: JSON.stringify({ error: `Broker "${value}" not found.` }) }],
            };
          }
          const broker = data as Record<string, unknown>;
          const locations = Array.isArray(broker.locations) ? broker.locations.join(", ") : "N/A";
          const lines = [
            `Name: ${broker.full_name || "Unknown"}`,
            `Phone: ${broker.phone || "N/A"}`,
            `Email: ${broker.email || "N/A"}`,
            `City: ${broker.city || "N/A"}`,
            `Agency: ${broker.agency_name || "N/A"}`,
            `Locations: ${locations}`,
            `Role: ${broker.app_role || "N/A"}`,
          ];
          return {
            structuredContent: { id: input.id, title: lines[0], text: lines.join("\n"), metadata: broker },
            content: [{ type: "text" as const, text: JSON.stringify({ id: input.id, title: lines[0], text: lines.join("\n"), metadata: broker }) }],
          };
        }

        case "building": {
          const result = await getBuildingIntel({
            building_name: value,
            locality: undefined,
            days_back: 90,
          });
          const saleAvg = result.price_benchmarks.sale?.avg_price_per_sqft;
          const rentAvg = result.price_benchmarks.rent?.avg_price_per_sqft;
          const lines = [
            `Building: ${result.building_name}`,
            `Localities: ${result.matched_localities.join(", ") || "N/A"}`,
            `Sale Benchmark: ${result.price_benchmarks.sale && saleAvg != null ? `${formatPerSqft(saleAvg)} avg, ${result.price_benchmarks.sale.listing_count} listings` : "N/A"}`,
            `Rent Benchmark: ${result.price_benchmarks.rent && rentAvg != null ? `${formatPerSqft(rentAvg)} avg, ${result.price_benchmarks.rent.listing_count} listings` : "N/A"}`,
            `Sample Days: ${result.sample_days}`,
            "",
            "Locality Supply:",
            ...result.locality_supply.slice(0, 5).map((ls) => `  ${ls.locality}: ${ls.listings} listings, ${ls.requirements} reqs - ${ls.ratio}`),
            "",
            "Config Mix:",
            ...result.configuration_map.slice(0, 5).map((cm) => `  ${cm.configuration}: ${cm.count} (${cm.percentage_of_locality}%)`),
          ];
          return {
            structuredContent: { id: input.id, title: lines[0], text: lines.join("\n"), metadata: result },
            content: [{ type: "text" as const, text: JSON.stringify({ id: input.id, title: lines[0], text: lines.join("\n"), metadata: result }) }],
          };
        }

        case "market": {
          const query = decodeURIComponent(value);
          const result = await executeSmartSearch({ query });
          const lines = [
            String(result.explanation || `Market intelligence for ${query}`),
            "",
            "Suggested follow-ups:",
            ...result.suggestedFollowUps.map((followUp) => `- ${followUp}`),
          ];
          return {
            structuredContent: { id: input.id, title: lines[0], text: lines.join("\n"), metadata: result },
            content: [{ type: "text" as const, text: JSON.stringify({ id: input.id, title: lines[0], text: lines.join("\n"), metadata: result }) }],
          };
        }

        default:
          return {
            structuredContent: { error: `Unknown ID type: ${type}. Supported types: listing, requirement, broker, building, market` },
            content: [{ type: "text" as const, text: JSON.stringify({ error: `Unknown ID type: ${type}. Supported types: listing, requirement, broker, building, market` }) }],
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        structuredContent: { error: message },
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
      };
    }
  });

  return server;
}

// Re-export all the functions for external use (e.g., in audit)
export {
  searchPublicListings,
  getFreshStream,
  getBrokerActivity,
  getHotLeadTriage,
  getStaleLeadReactivation,
  matchBuyerToInventory,
  qualifyLead,
  saveListingRecord,
  createRequirementRecord,
  scheduleFollowUp,
  summarizeThread,
  extractThreadActionsWithLlm,
  buildPricingNegotiationBrief,
  estimatePrice,
  getMarketSummary,
  getBuildingIntel,
  getIgrPrice,
  buildBroadcastDraft,
  describeSearch,
  draftGrowthAssetWithLlm,
  summarizeBrokerThreadWithLlm,
  generateEmbedding,
  formatCurrencyCr,
  formatPerSqft,
  formatSqft,
  listingLine,
  getListingById,
  searchBrokers,
  executeSmartSearch,
};
