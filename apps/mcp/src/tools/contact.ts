import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchListingById, findBrokers as findBrokersData, logToolCall } from "../data.ts";
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

export function registerContactTools(server: McpServer, context: ToolContext) {
  server.registerTool("contact_search", {
    description: "Search for broker contacts by location, city, or specialization",
    inputSchema: {
      location: z.string().optional().describe("Locality filter"),
      city: z.string().optional().describe("City (defaults to Mumbai)"),
      specialization: z.string().optional().describe("Specialization (e.g. 'luxury', 'commercial')"),
      limit: z.number().optional().default(20),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "contact_search", input);
    const brokers = await findBrokersData({ locality: input.location, city: input.city, specialization: input.specialization, limit: input.limit });
    if (!brokers.length) return textResponse("No contacts found.", { contacts: [] });
    const list = brokers.map((b: any) => `${b.full_name || "Unknown"}${b.phone ? ` · ${b.phone}` : ""}${b.locations?.length ? ` [${b.locations.join(", ")}]` : ""}`).join("\n");
    return textResponse(`${brokers.length} contact(s):\n${list}`, { contacts: brokers });
  });

  server.registerTool("contact_call", {
    description: "Get the phone number for a broker contact",
    inputSchema: {
      listing_id: z.string().optional().describe("Listing id returned by listing_get"),
      name: z.string().optional().describe("Broker name"),
      phone: z.string().optional().describe("Broker phone number"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "contact_call", input);
    if (input.listing_id) {
      const listing = await fetchListingById(input.listing_id);
      if (listing?.primary_contact_number || listing?.primary_contact_wa) {
        const phone = listing.primary_contact_number || listing.primary_contact_wa;
        return textResponse(`${listing.primary_contact_name || "Broker"}: ${phone}`, {
          listing_id: input.listing_id,
          name: listing.primary_contact_name,
          phone,
        });
      }
    }

    if (input.phone) {
      return textResponse(`Contact: ${input.phone}`, { name: input.name || null, phone: input.phone });
    }

    const brokers = await findBrokersData({ limit: 10 });
    const broker = input.name ? brokers.find((b: any) => b.full_name?.toLowerCase().includes(input.name!.toLowerCase())) : null;
    if (!broker) return textResponse("Contact not found.", { contact: null });
    return textResponse(`${broker.full_name || "Contact"}: ${broker.phone || "No phone"}`, { name: broker.full_name, phone: broker.phone });
  });

  server.registerTool("contact_whatsapp", {
    description: "Get the WhatsApp link for a phone number",
    inputSchema: {
      phone: z.string().describe("Phone number"),
      message: z.string().optional().describe("Optional pre-filled message"),
    },
  }, async (input) => {
    const id = brokerId(context);
    await logToolCall(id, "contact_whatsapp", input);
    const digits = input.phone.replace(/\D/g, "").slice(-10);
    const waLink = `https://wa.me/91${digits}${input.message ? "?text=" + encodeURIComponent(input.message) : ""}`;
    return textResponse(`WhatsApp: ${waLink}`, { wa_link: waLink, phone: `+91${digits}`, message: input.message || null });
  });
}
