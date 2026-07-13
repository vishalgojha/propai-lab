import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./index.js";
import dotenv from "dotenv";
dotenv.config();
// Local execution context (read from environment or default to a fallback)
const userId = process.env.PROPAI_USER_ID || "local-admin";
const brokerId = process.env.PROPAI_BROKER_ID || userId;
const server = createMcpServer({
    user: {
        id: userId,
        broker_id: brokerId,
        email: "local-admin@propai.live",
        aud: "authenticated",
        role: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: new Date().toISOString(),
    },
});
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("PropAI Stdio MCP server running...");
