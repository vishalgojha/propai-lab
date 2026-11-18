import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, MCP_TOOL_NAMES } from "./index.js";
import { mountRawBrokerRoute } from "./rawRoute.js";
import { configureRawOAuth, mountRawOAuth, rawProtectedResourceMetadata, verifyRawAccessToken, boundTenantResolver } from "./rawOAuth.js";
import {
  deviceAuthorizeHandler,
  oauthAuthorizationServerMetadata,
  oauthAuthorizeGetHandler,
  oauthAuthorizePostHandler,
  oauthProtectedResourceMetadata,
  oauthRegisterHandler,
  oauthTokenHandler,
  publicUrl,
  setMcpUnauthorizedHeaders,
} from "./oauth.js";
import { closeSessionRecord, createSessionRecord, touchSessionRecord } from "./sessionStore.js";
import { resolveBrokerIdForUser, resolveTenantIdForUser, verifyPropAIToken } from "./supabase.js";
import type { AuthenticatedUser } from "./types.js";
import { createAuthMiddleware } from "./mcpAccess.js";
import { createMcpHandler, type McpSession } from "./mcpHttp.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      publicOnly?: boolean;
    }
  }
}

const app = express();
const PORT = Number(process.env.MCP_PORT || 3000);
const PUBLIC_URL = process.env.MCP_SERVER_URL || "https://mcp.propai.live";

const sessions = new Map<string, McpSession>();

app.use("/assets", express.static("public", { immutable: true, maxAge: "30d" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
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
      .from("parsed_output_unified")
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
app.get("/.well-known/oauth-protected-resource", (req, res) => oauthProtectedResourceMetadata(req, res));
app.get("/authorize", oauthAuthorizeGetHandler);
app.post("/authorize", oauthAuthorizePostHandler);
app.post("/oauth/token", oauthTokenHandler);
app.post("/register", oauthRegisterHandler);
app.post("/device/authorize", deviceAuthorizeHandler);

const accessDeps = {
  verify: verifyPropAIToken,
  resolveBrokerId: resolveBrokerIdForUser,
  resolveTenantId: resolveTenantIdForUser,
  challenge: (req: Request, res: Response) => setMcpUnauthorizedHeaders(req, res),
};
// The 15-day trial starts on the first successful assistant search (recorded
// inside the search tool handlers), never on authentication or session setup.
const authMiddleware = createAuthMiddleware("public-or-user", accessDeps);

const handleMcp = createMcpHandler({
  sessions,
  createServer: createMcpServer,
  challenge: (req, res) => setMcpUnauthorizedHeaders(req, res),
  records: { create: createSessionRecord, touch: touchSessionRecord, close: closeSessionRecord },
});
app.all("/mcp", authMiddleware, handleMcp);
// Limited sign-in for /raw-mcp: opaque route-only tokens; the legacy flow above is unchanged.
configureRawOAuth({ verifySession: verifyPropAIToken, resolveTenantId: resolveTenantIdForUser, publicUrl });
mountRawOAuth(app);
const rawAccessDeps = {
  verify: verifyRawAccessToken,
  resolveBrokerId: async (user: { id: string }) => user.id,
  resolveTenantId: boundTenantResolver(resolveTenantIdForUser), // live membership must still equal the org signed in for
  challenge: accessDeps.challenge,
};
const rawSessions = mountRawBrokerRoute(app, {
  access: rawAccessDeps as never,
  challenge: (req, res, metadataPath) => setMcpUnauthorizedHeaders(req, res, metadataPath),
  records: { create: createSessionRecord, touch: touchSessionRecord, close: closeSessionRecord },
  metadata: (req, res) => rawProtectedResourceMetadata(req, res),
});

async function closeSessions() {
  await Promise.all(
    [...sessions.values(), ...rawSessions.values()].map(async (session) => {
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
