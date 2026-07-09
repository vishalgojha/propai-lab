import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStoredThreadMessages, summarizeThread, logToolCall } from "../data.ts";
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

export function registerInboxTools(server: McpServer, context: ToolContext) {
  server.registerTool("conversation_search", {
    description: "Search stored WhatsApp conversations by JID or browse recent threads",
    inputSchema: {
      query: z.string().optional().describe("JID or keyword to search for"),
      limit: z.number().optional().default(20),
    },
  }, async (input) => {
    const id = requireBrokerId(context);
    await logToolCall(id, "conversation_search", input);
    const messages = await getStoredThreadMessages({ brokerId: id, limit: input.limit });
    if (!messages.length) return textResponse("No stored conversations found.", { conversations: [] });
    const jids = [...new Set(messages.map((m) => m.remote_jid).filter(Boolean))];
    return textResponse(`${jids.length} conversation(s) found. Use conversation_timeline with a specific JID to view messages.`, { conversations: jids, message_count: messages.length });
  });

  server.registerTool("conversation_timeline", {
    description: "Get the full timeline of a WhatsApp conversation — all stored messages in order",
    inputSchema: {
      remote_jid: z.string().describe("WhatsApp JID (e.g. '919876543210@s.whatsapp.net')"),
      limit: z.number().optional().default(50),
    },
  }, async (input) => {
    const id = requireBrokerId(context);
    await logToolCall(id, "conversation_timeline", input);
    const messages = await getStoredThreadMessages({ brokerId: id, remoteJid: input.remote_jid, limit: input.limit });
    if (!messages.length) return textResponse(`No messages found for "${input.remote_jid}".`, { messages: [] });
    const summary = messages.slice(0, 5).map((m) => `${m.sender || "unknown"}: ${(m.text || "").slice(0, 80)}`).join("\n");
    return textResponse(`${messages.length} message(s) in conversation.\nRecent:\n${summary}`, { messages, total: messages.length });
  });

  server.registerTool("conversation_summarize", {
    description: "Summarize a WhatsApp conversation — extract key points, participants, and activity",
    inputSchema: {
      remote_jid: z.string().describe("WhatsApp JID"),
      limit: z.number().optional().default(40),
    },
  }, async (input) => {
    const id = requireBrokerId(context);
    await logToolCall(id, "conversation_summarize", input);
    const result = await summarizeThread({ brokerId: id, remote_jid: input.remote_jid, limit: input.limit });
    const keyPoints = result.key_points?.slice(-3).map((kp: any) => `• ${kp.sender}: ${kp.text.slice(0, 120)}`).join("\n") || "";
    return textResponse(
      `${result.message_count} messages · ${result.inbound_count} in / ${result.outbound_count} out\nParticipants: ${result.participants?.join(", ") || "N/A"}\n${keyPoints ? `\nKey points:\n${keyPoints}` : ""}`,
      result,
    );
  });

  server.registerTool("conversation_reply", {
    description: "Draft a reply message for a WhatsApp conversation (requires Evolution API to send)",
    inputSchema: {
      remote_jid: z.string().describe("WhatsApp JID to reply to"),
      message: z.string().describe("Reply message text"),
    },
  }, async (input) => {
    const id = requireBrokerId(context);
    await logToolCall(id, "conversation_reply", input);
    return textResponse(
      `Draft for ${input.remote_jid}: "${input.message}"\n\nSending requires Evolution API integration — your draft is ready for manual sending.`,
      { remote_jid: input.remote_jid, draft: input.message, sent: false },
    );
  });
}
