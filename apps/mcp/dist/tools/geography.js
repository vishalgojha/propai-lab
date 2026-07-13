import { z } from "zod";
import { getMarketSummary, logToolCall } from "../data.js";
function textResponse(text, structured) {
    return {
        content: [{ type: "text", text }],
        structuredContent: structured,
    };
}
function brokerId(context) {
    return context?.user?.broker_id || context?.user?.id;
}
export function registerGeographyTools(server, context) {
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
        return textResponse(`${input.location}: ${result.listing_count} listings, avg ₹${result.avg_price_cr || "N/A"} Cr, avg ₹${result.avg_price_per_sqft || "N/A"}/sqft`, result);
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
