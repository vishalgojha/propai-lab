import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall, searchRawMessages } from "../data.ts";
import type { ToolContext } from "../types.js";

function textResponse(text: string, structured?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured as Record<string, unknown> | undefined,
  };
}

function requireTenantId(context: ToolContext) {
  const id = String(context.user?.tenant_id || "").trim();
  if (!id) throw new Error("Authenticated organization scope is required for raw message search");
  return id;
}

export function registerRawMessageTools(server: McpServer, context: ToolContext) {
  server.registerTool("raw_message_search", {
    description:
      "Search the tenant's original WhatsApp messages as raw evidence. Results are unparsed context, not verified listings or requirements; use market_search for normalized inventory.",
    inputSchema: {
      query: z.string().optional().describe("Words or phrase to find in the original message text"),
      group_name: z.string().optional().describe("Optional group name or partial group name"),
      sender: z.string().optional().describe("Optional sender name or partial sender name"),
      scope: z.enum(["groups", "all"]).optional().default("groups").describe("Search group messages or all tenant messages"),
      since: z.string().optional().describe("ISO date/time; defaults to the last 30 days"),
      until: z.string().optional().describe("ISO date/time; defaults to now"),
      limit: z.number().int().min(1).max(100).optional().default(25),
    },
  }, async (input) => {
    const tenantId = requireTenantId(context);
    const brokerId = context.user?.broker_id || context.user?.id;
    await logToolCall(brokerId, "raw_message_search", input, tenantId);
    const result = await searchRawMessages({
      tenantId,
      query: input.query,
      groupName: input.group_name,
      sender: input.sender,
      scope: input.scope,
      since: input.since,
      until: input.until,
      limit: input.limit,
    });

    const summary = result.items.length
      ? `Found ${result.items.length} raw message(s) from ${result.since} to ${result.until}${result.has_more ? " (more are available; narrow the query or time window)" : ""}.`
      : "No raw messages matched this tenant-scoped search.";
    return textResponse(
      `${summary}\nThese are original WhatsApp messages, not parsed or verified inventory.`,
      {
        source: "raw_whatsapp_messages",
        interpretation: "raw evidence only; not verified inventory or requirements",
        ...result,
      },
    );
  });
}
