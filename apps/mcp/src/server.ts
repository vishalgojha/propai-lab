import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, MCP_TOOL_NAMES } from "./index.js";
import {
  deviceAuthorizeHandler,
  oauthAuthorizationServerMetadata,
  oauthAuthorizeGetHandler,
  oauthAuthorizePostHandler,
  oauthProtectedResourceMetadata,
  oauthRegisterHandler,
  oauthTokenHandler,
  setMcpUnauthorizedHeaders,
} from "./oauth.js";
import { closeSessionRecord, createSessionRecord, touchSessionRecord } from "./sessionStore.js";
import { resolveBrokerIdForUser, verifyPropAIToken } from "./supabase.js";
import type { AuthenticatedUser } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3003);
const PUBLIC_URL = process.env.MCP_SERVER_URL || "https://mcp.propai.live";

type McpSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, McpSession>();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.head("/", (_req, res) => res.status(200).end());

app.get("/", (_req, res) => {
  res.json({
    name: "PropAI MCP Server",
    version: "1.0.0",
    description: "Broker workflow, listings, CRM, thread summaries, and market intelligence from PropAI",
    transport: "streamable-http",
    endpoint: `${PUBLIC_URL}/mcp`,
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "propai-mcp", port: PORT });
});

app.get("/debug", async (_req, res) => {
  const { supabase } = await import("./supabase.js");
  const diagnostics: Record<string, unknown> = {
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL ? "set" : "MISSING",
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "MISSING",
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ? "set" : "MISSING",
      PORT: process.env.PORT || "MISSING",
    },
    supabaseClient: "unknown",
    queryTest: "not_run",
  };

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    diagnostics.supabaseClient = "NOT_CONFIGURED";
    return res.status(503).json(diagnostics);
  }

  try {
    const { data, error } = await supabase
      .from("public_listings")
      .select("count")
      .limit(1);

    if (error) {
      diagnostics.queryTest = `ERROR: ${error.message}`;
    } else {
      diagnostics.queryTest = `OK (${JSON.stringify(data)})`;
    }
    diagnostics.supabaseClient = "configured";
  } catch (e) {
    diagnostics.queryTest = `CRASH: ${e instanceof Error ? e.message : String(e)}`;
    diagnostics.supabaseClient = "configured_but_crashed";
  }

  res.json(diagnostics);
});

app.get("/.well-known/mcp-server.json", (_req, res) => {
  res.json({
    name: "PropAI MCP Server",
    version: "1.0.0",
    description: "Broker workflow, listings, CRM, thread summaries, and market intelligence from PropAI",
    endpoints: {
      streamableHttp: `${PUBLIC_URL}/mcp`,
      oauthToken: `${PUBLIC_URL}/oauth/token`,
    },
    auth: {
      type: "bearer",
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
    },
    capabilities: {
      tools: MCP_TOOL_NAMES,
    },
  });
});

app.get("/.well-known/oauth-authorization-server", oauthAuthorizationServerMetadata);
app.get("/.well-known/oauth-protected-resource", oauthProtectedResourceMetadata);
app.get("/authorize", oauthAuthorizeGetHandler);
app.post("/authorize", oauthAuthorizePostHandler);
app.post("/oauth/token", oauthTokenHandler);
app.post("/register", oauthRegisterHandler);
app.post("/device/authorize", deviceAuthorizeHandler);

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  if (!token) {
    setMcpUnauthorizedHeaders(req, res);
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const user = await verifyPropAIToken(token);
    const brokerId = await resolveBrokerIdForUser(user);
    req.user = {
      ...user,
      broker_id: brokerId || user.broker_id || user.id,
    };
    return next();
  } catch {
    setMcpUnauthorizedHeaders(req, res);
    return res.status(401).json({ error: "Invalid token" });
  }
}

app.all("/mcp", authMiddleware, async (req: Request, res: Response) => {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessionId = req.headers["mcp-session-id"];
  let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (typeof sessionId === "string") {
    await touchSessionRecord(sessionId).catch(() => {});
  }

  if (!session) {
    const server = createMcpServer({ user: req.user });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (newSessionId) => {
        sessions.set(newSessionId, { server, transport });
        await createSessionRecord({
          sessionId: newSessionId,
          userId: req.user?.id,
          userAgent: String(req.headers["user-agent"] || ""),
        }).catch(() => {});
      },
      onsessionclosed: async (closedSessionId) => {
        const closedSession = sessions.get(closedSessionId);
        sessions.delete(closedSessionId);
        await closeSessionRecord(closedSessionId).catch(() => {});
        await closedSession?.server.close();
      },
    });

    transport.onclose = async () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        await closeSessionRecord(transport.sessionId).catch(() => {});
      }
    };

    session = { server, transport };
    await server.connect(transport);
  }

  try {
    await session.transport.handleRequest(req, res, req.method === "POST" ? req.body : undefined);
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

async function closeSessions() {
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      await session.transport.close();
      await session.server.close();
    }),
  );
}

process.on("SIGTERM", async () => {
  await closeSessions();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await closeSessions();
  process.exit(0);
});

const httpServer = app.listen(PORT, () => {
  console.log(`PropAI MCP server running on port ${PORT}`);
});

httpServer.on("error", (error) => {
  console.error("Failed to start PropAI MCP server:", error);
  process.exit(1);
});
