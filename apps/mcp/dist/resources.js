import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractThreadActionsWithLlm } from "./ai.js";
import { getBrokerActivity, getHotLeadTriage, getPendingFollowUps, getRecentRequirements, getRecentSavedListings, getStoredThreadMessages, } from "./data.js";
import { LISTING_CARDS_URI, MCP_APP_MIME_TYPE, listingCardsHtml } from "./uiResources.js";
function brokerId(context) {
    return context?.user?.broker_id || context?.user?.id;
}
function requireBrokerId(context) {
    const id = brokerId(context);
    if (!id) {
        throw new Error("Authenticated broker id is required for this resource");
    }
    return id;
}
function jsonResource(uri, payload) {
    return {
        contents: [
            {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(payload, null, 2),
            },
        ],
    };
}
function listResourceUris(items) {
    const uniqueItems = [...new Set(items.map((item) => item.remote_jid))];
    return {
        resources: uniqueItems.map((remoteJid) => ({
            uri: `propai://thread/${encodeURIComponent(remoteJid)}`,
            name: remoteJid,
            mimeType: "application/json",
            description: `Stored thread history for ${remoteJid}`,
        })),
    };
}
export function registerMcpResources(server, context = {}) {
    server.registerResource("listing-cards-ui", LISTING_CARDS_URI, {
        title: "PropAI Listing Cards",
        description: "Interactive cards for PropAI listing search results.",
        mimeType: MCP_APP_MIME_TYPE,
    }, async () => ({
        contents: [
            {
                uri: LISTING_CARDS_URI,
                mimeType: MCP_APP_MIME_TYPE,
                text: listingCardsHtml,
            },
        ],
    }));
    server.registerResource("broker-activity", "propai://broker/activity", {
        title: "Broker Activity Snapshot",
        description: "Workspace KPI snapshot with lead volume, active chats, and top localities.",
        mimeType: "application/json",
    }, async (uri) => {
        const id = requireBrokerId(context);
        const payload = await getBrokerActivity({ brokerId: id, days: 7 });
        return jsonResource(uri.toString(), payload);
    });
    server.registerResource("broker-hot-leads", "propai://broker/hot-leads", {
        title: "Hot Lead Triage",
        description: "Ranked hot leads based on priority, urgency, follow-up pressure, and recent message signals.",
        mimeType: "application/json",
    }, async (uri) => {
        const id = requireBrokerId(context);
        const payload = await getHotLeadTriage({ brokerId: id, days: 7, limit: 12 });
        return jsonResource(uri.toString(), payload);
    });
    server.registerResource("broker-followups", "propai://broker/followups", {
        title: "Pending Follow-Ups",
        description: "The broker's pending follow-up queue.",
        mimeType: "application/json",
    }, async (uri) => {
        const id = requireBrokerId(context);
        const items = await getPendingFollowUps({ brokerId: id, limit: 25 });
        return jsonResource(uri.toString(), {
            count: items.length,
            items,
        });
    });
    server.registerResource("broker-listings", "propai://broker/listings", {
        title: "Saved Listings",
        description: "Recent listings saved into the broker CRM workspace.",
        mimeType: "application/json",
    }, async (uri) => {
        const id = requireBrokerId(context);
        const items = await getRecentSavedListings({ brokerId: id, limit: 50 });
        return jsonResource(uri.toString(), {
            count: items.length,
            items,
        });
    });
    server.registerResource("broker-requirements", "propai://broker/requirements", {
        title: "Saved Requirements",
        description: "Recent buyer and tenant requirements saved into the broker CRM workspace.",
        mimeType: "application/json",
    }, async (uri) => {
        const id = requireBrokerId(context);
        const items = await getRecentRequirements({ brokerId: id, limit: 50 });
        return jsonResource(uri.toString(), {
            count: items.length,
            items,
        });
    });
    server.registerResource("broker-thread-template", new ResourceTemplate("propai://thread/{remote_jid}", {
        list: async () => {
            const id = requireBrokerId(context);
            const items = await getStoredThreadMessages({ brokerId: id, limit: 10 });
            return listResourceUris(items);
        },
        complete: {
            remote_jid: async (value) => {
                const id = requireBrokerId(context);
                const items = await getStoredThreadMessages({ brokerId: id, limit: 25 });
                return [...new Set(items
                        .map((item) => item.remote_jid)
                        .filter((item) => item.toLowerCase().includes(value.toLowerCase()))
                        .slice(0, 20))];
            },
        },
    }), {
        title: "Stored Thread History",
        description: "Stored message history for a selected WhatsApp chat thread.",
        mimeType: "application/json",
    }, async (uri, variables) => {
        const id = requireBrokerId(context);
        const remoteJid = String(variables.remote_jid || "").trim();
        const items = await getStoredThreadMessages({ brokerId: id, remoteJid, limit: 100 });
        return jsonResource(uri.toString(), {
            remote_jid: remoteJid,
            count: items.length,
            summary: items.slice(-10).map((item) => ({
                sender: item.sender,
                text: item.text,
                timestamp: item.timestamp || item.created_at,
            })),
        });
    });
    server.registerResource("broker-thread-actions-template", new ResourceTemplate("propai://thread/{remote_jid}/actions", {
        list: async () => {
            const id = requireBrokerId(context);
            const items = await getStoredThreadMessages({ brokerId: id, limit: 10 });
            return {
                resources: [...new Set(items.map((item) => item.remote_jid))].map((remoteJid) => ({
                    uri: `propai://thread/${encodeURIComponent(remoteJid)}/actions`,
                    name: `${remoteJid} actions`,
                    mimeType: "application/json",
                    description: `Extracted broker workflow actions for ${remoteJid}`,
                })),
            };
        },
        complete: {
            remote_jid: async (value) => {
                const id = requireBrokerId(context);
                const items = await getStoredThreadMessages({ brokerId: id, limit: 25 });
                return [...new Set(items
                        .map((item) => item.remote_jid)
                        .filter((item) => item.toLowerCase().includes(value.toLowerCase()))
                        .slice(0, 20))];
            },
        },
    }), {
        title: "Thread Action Extraction",
        description: "Likely CRM actions extracted from stored thread history.",
        mimeType: "application/json",
    }, async (uri, variables) => {
        const id = requireBrokerId(context);
        const remoteJid = String(variables.remote_jid || "").trim();
        const items = await getStoredThreadMessages({ brokerId: id, remoteJid, limit: 80 });
        const actions = await extractThreadActionsWithLlm({
            remoteJid,
            lines: items
                .filter((item) => String(item.text || "").trim())
                .slice(-12)
                .map((item) => `${item.sender || "Unknown"}: ${String(item.text || "").slice(0, 240)}`),
        });
        return jsonResource(uri.toString(), {
            remote_jid: remoteJid,
            message_count: items.length,
            ...actions,
        });
    });
}
