import { z } from "zod";
import { searchBrokers as searchBrokersData, getBrokerActivity, logToolCall } from "../data.js";
function textResponse(text, structured) {
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
}
function brokerId(context) {
    return context?.user?.broker_id || context?.user?.id;
}
function requireBrokerId(context) {
    const id = brokerId(context);
    if (!id)
        throw new Error("Authenticated broker id is required for this tool");
    return id;
}
export function registerBrokerTools(server, context) {
    server.registerTool("broker_search", {
        description: "Search for brokers by location, city, or specialization",
        inputSchema: {
            location: z.string().optional().describe("Locality the broker operates in (e.g. 'Bandra West', 'Powai')"),
            city: z.string().optional().describe("City (defaults to Mumbai)"),
            specialization: z.string().optional().describe("Specialization area (e.g. 'luxury', 'commercial', 'rentals')"),
            limit: z.number().optional().default(20),
        },
    }, async (input) => {
        const id = brokerId(context);
        await logToolCall(id, "broker_search", input);
        const brokers = await searchBrokersData({
            locality: input.location,
            city: input.city,
            specialization: input.specialization,
            limit: input.limit,
        });
        if (!brokers.length) {
            return textResponse("No brokers found matching your search.", { brokers: [] });
        }
        const summary = brokers.map((b) => `${b.full_name || "Unknown"}${b.phone ? ` · ${b.phone}` : ""}`).join("\n");
        return textResponse(`${brokers.length} broker(s) found:\n${summary}`, { brokers });
    });
    server.registerTool("broker_profile", {
        description: "Get detailed profile for a broker — contact info, locations, role",
        inputSchema: {
            name: z.string().optional().describe("Broker name to look up"),
            phone: z.string().optional().describe("Broker phone number to look up"),
        },
    }, async (input) => {
        const id = brokerId(context);
        await logToolCall(id, "broker_profile", input);
        const brokers = await searchBrokersData({ limit: 5 });
        const broker = brokers.find((b) => (input.name && b.full_name?.toLowerCase().includes(input.name.toLowerCase())) ||
            (input.phone && b.phone?.includes(input.phone)));
        if (!broker) {
            return textResponse("Broker not found. Try searching by location instead.", { broker: null });
        }
        return textResponse(`Profile: ${broker.full_name || "Unknown"}${broker.phone ? ` · ${broker.phone}` : ""}`, broker);
    });
    server.registerTool("broker_activity", {
        description: "Get your recent activity — leads saved, follow-ups scheduled, messages exchanged",
        inputSchema: {
            days: z.number().optional().default(7).describe("Number of days to look back (default 7)"),
        },
    }, async (input) => {
        const id = requireBrokerId(context);
        await logToolCall(id, "broker_activity", input);
        const result = await getBrokerActivity({ brokerId: id, days: input.days });
        return textResponse(`Activity over ${input.days}d: ${result.leads_total} total leads, ${result.listings_total} listings, ${result.requirements_total} requirements, ${result.messages_total} messages, ${result.pending_follow_ups} pending follow-ups`, result);
    });
    server.registerTool("broker_inventory", {
        description: "Get your current inventory — active listings and requirements you're tracking",
        inputSchema: {
            limit: z.number().optional().default(20),
        },
    }, async (input) => {
        const id = requireBrokerId(context);
        await logToolCall(id, "broker_inventory", input);
        const activity = await getBrokerActivity({ brokerId: id, days: 90 });
        return textResponse(`Your inventory (90d): ${activity.listings_total} listings, ${activity.requirements_total} requirements, ${activity.pending_follow_ups} pending follow-ups`, activity);
    });
}
