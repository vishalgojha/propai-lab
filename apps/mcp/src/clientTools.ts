/**
 * Signed-in client MCP surface (PropAI account without a brokerage workspace).
 *
 * A client account gets the account-free public market tools plus
 * save_client_contact, so the client's own assistant can leave the name and
 * number the client gives it for follow-up. No broker tools, no tenant data,
 * no raw messages, and no broker phone numbers - the same data guarantees as
 * the public surface (publicTools.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createPublicMcpServer } from "./publicTools.js";
import { normalizeClientPhone, saveClientContact } from "./clientAccess.js";
import type { AuthenticatedUser } from "./types.js";

function textPayload(payload: Record<string, unknown>) {
  return {
    structuredContent: payload,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function createClientMcpServer(user?: AuthenticatedUser): McpServer {
  const server = createPublicMcpServer();

  server.registerTool(
    "save_client_contact",
    {
      description:
        "Save the client's own name and WhatsApp/mobile number so the PropAI team can follow up on their property search. Ask the client for their name and number first and call this once with what they gave you; never guess or invent values, and never save anyone else's details.",
      inputSchema: {
        full_name: z.string().min(1).describe("The client's name, exactly as they gave it"),
        phone: z.string().describe("The client's WhatsApp/mobile number with country code"),
      },
    },
    async (input) => {
      if (!user?.id) {
        return textPayload({ error: "Sign in to your PropAI account before saving contact details." });
      }
      const fullName = String(input.full_name || "").trim();
      if (!fullName) {
        return textPayload({ error: "Ask the client for their name before saving." });
      }
      const phone = normalizeClientPhone(input.phone);
      if (!phone) {
        return textPayload({
          error: "That number does not look valid; ask the client to share their WhatsApp number with country code.",
        });
      }
      await saveClientContact(user, fullName, phone);
      return textPayload({ saved: true, note: "Saved the client's name and number for PropAI follow-up." });
    },
  );

  return server;
}
