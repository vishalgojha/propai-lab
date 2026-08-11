import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchListingById, logToolCall } from "../data.ts";
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

export function registerListingTools(server: McpServer, context: ToolContext) {
  server.registerTool("listing_get", {
    description: "Get full details for a specific listing by ID — price, location, broker, description",
    inputSchema: {
      listing_id: z.string().describe("The listing source_message_id"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "listing_get", input);
    const listing = await fetchListingById(input.listing_id);
    if (!listing) return textResponse(`Listing "${input.listing_id}" not found.`, { listing: null });
    return textResponse(
      `${listing.title || "Listing"} — ₹${listing.price || "N/A"} Cr · ${listing.bhk || "?"} BHK · ${listing.sub_area || listing.area || listing.location || ""}${listing.primary_contact_name ? ` · ${listing.primary_contact_name}` : ""}`,
      listing,
    );
  });

  server.registerTool("get_listing", {
    description: "Get full details for a listing by ID — ChatGPT-compatible alias for listing_get",
    inputSchema: {
      listing_id: z.string().describe("The listing source_message_id"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "get_listing", input);
    const listing = await fetchListingById(input.listing_id);
    if (!listing) return textResponse(`Listing "${input.listing_id}" not found.`, { listing: null });
    return textResponse(
      `${listing.title || "Listing"} — ₹${listing.price || "N/A"} Cr · ${listing.bhk || "?"} BHK · ${listing.sub_area || listing.area || listing.location || ""}${listing.primary_contact_name ? ` · ${listing.primary_contact_name}` : ""}`,
      deprecatedAlias(listing, "listing_get"),
    );
  });

  server.registerTool("listing_similar", {
    description: "Find similar listings by location, BHK, or budget",
    inputSchema: {
      location: z.string().optional(),
      bhk: z.number().optional(),
      max_budget_cr: z.number().optional(),
      property_type: z.enum(["sale", "rent", "lease", "all"]).optional().default("sale"),
      limit: z.number().optional().default(10),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "listing_similar", input);
    return textResponse("Use market_search with location + BHK to find similar listings.", { filters: input });
  });

  server.registerTool("listing_history", {
    description: "Get the history of a listing — first seen, source, and metadata",
    inputSchema: {
      listing_id: z.string().describe("The listing ID"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "listing_history", input);
    const listing = await fetchListingById(input.listing_id);
    if (!listing) return textResponse(`Listing "${input.listing_id}" not found.`, { listing: null });
    return textResponse(
      `Listing ${input.listing_id}: created ${listing.created_at || "unknown"}, source: ${listing.source_group_name || listing.listing_type || "unknown"}`,
      { listing },
    );
  });

  const contactBroker = async (input: { listing_id: string }, toolName: string, deprecated = false) => {
    const id = brokerId(context);
    await logToolCall(id, toolName, input);
    const listing = await fetchListingById(input.listing_id);
    if (!listing) return textResponse(`Listing "${input.listing_id}" not found.`, { listing: null });
    const broker = listing.primary_contact_name || "Unknown";
    const phone = listing.primary_contact_number || "";
    const waLink = listing.primary_contact_wa || (phone ? `https://wa.me/91${phone.replace(/\D/g, "").slice(-10)}` : null);
    const payload = { broker_name: broker, phone, wa_link: waLink };
    return textResponse(
      `Listed by ${broker}${phone ? ` · ${phone}` : ""}${waLink ? `\nChat: ${waLink}` : ""}`,
      deprecated ? deprecatedAlias(payload, "listing_contact_broker") : payload,
    );
  };

  server.registerTool("listing_contact_broker", {
    description: "Get the broker/contact info for a listing — name, phone, WhatsApp link",
    inputSchema: {
      listing_id: z.string().describe("The listing ID"),
    },
  }, async (input) => contactBroker(input, "listing_contact_broker"));

  server.registerTool("listing_contactBroker", {
    description: "Deprecated 30-day alias for listing_contact_broker.",
    inputSchema: { listing_id: z.string().describe("The listing ID") },
  }, async (input) => contactBroker(input, "listing_contactBroker", true));

  server.registerTool("listing_timeline", {
    description: "Get listing timeline — created date and metadata",
    inputSchema: {
      listing_id: z.string().describe("The listing ID"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "listing_timeline", input);
    const listing = await fetchListingById(input.listing_id);
    if (!listing) return textResponse(`Listing "${input.listing_id}" not found.`, { listing: null });
    return textResponse(
      `Listing ${input.listing_id}: created ${listing.created_at || "unknown"}, price ₹${listing.price || "N/A"} Cr`,
      { listing },
    );
  });
}
