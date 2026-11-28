import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, MCP_TOOL_NAMES } from "./index.js";
import { createRawMcpServer } from "./rawServer.js";
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
import { isClientAccount, signupClient } from "./clientAccess.js";
import { closeSessionRecord, createSessionRecord, touchSessionRecord } from "./sessionStore.js";
import { resolveBrokerIdForUser, resolveTenantIdForUser, verifyPropAIToken } from "./supabase.js";
import type { AuthenticatedUser } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      publicOnly?: boolean;
      clientOnly?: boolean;
    }
  }
}

const app = express();
const PORT = Number(process.env.MCP_PORT || 3000);
const PUBLIC_URL = process.env.MCP_SERVER_URL || "https://mcp.propai.live";

type McpSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  // Identity the session was created for; later requests must match it.
  ownerId?: string | null;
  publicOnly?: boolean;
  clientOnly?: boolean;
};

const sessions = new Map<string, McpSession>();

// A session id is not a credential: tenant/broker context is baked into the
// server instance at creation, so every later request must be made by the
// same identity (or same public-only status) the session was created for.
function sessionMatchesRequest(session: McpSession, req: Request): boolean {
  if ((session.publicOnly === true) !== (req.publicOnly === true)) return false;
  if ((session.clientOnly === true) !== (req.clientOnly === true)) return false;
  return (session.ownerId ?? null) === (req.user?.id ?? null);
}

app.use("/assets", express.static("public", { immutable: true, maxAge: "30d" }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version");
  res.header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  // Browser-based MCP clients must be able to read the session header.
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
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
app.get("/.well-known/oauth-protected-resource", oauthProtectedResourceMetadata);
app.get("/.well-known/oauth-protected-resource/raw-mcp", oauthProtectedResourceMetadata);
app.get("/authorize", oauthAuthorizeGetHandler);
app.post("/authorize", oauthAuthorizePostHandler);
app.post("/oauth/token", oauthTokenHandler);
app.post("/register", oauthRegisterHandler);
app.post("/device/authorize", deviceAuthorizeHandler);

async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";

  if (!token) {
    // Account-free public access: no token means the public market toolset
    // only. A presented token is still strictly verified below - invalid or
    // expired credentials keep failing with 401 and never downgrade into a
    // silent public session, so callers always know when auth broke.
    req.publicOnly = true;
    return next();
  }

  try {
    const user = await verifyPropAIToken(token);
    // A client account (service-written client_accounts row) is always
    // client-only, even if a workspace was auto-created for it at signup.
    // A failed lookup is refused rather than falling through to broker access.
    let isClient: boolean;
    try {
      isClient = await isClientAccount(user.id);
    } catch {
      return res.status(503).json({ error: "Account check unavailable. Try again." });
    }
    if (isClient) {
      req.user = { ...user, broker_id: undefined, tenant_id: undefined } as AuthenticatedUser;
      req.clientOnly = true;
      return next();
    }
    const brokerId = await resolveBrokerIdForUser(user);
    const tenantId = await resolveTenantIdForUser(user);
    if (!tenantId) {
      setMcpUnauthorizedHeaders(req, res);
      return res.status(403).json({ error: "Tenant membership is required" });
    }
    // The 15-day trial starts on the first successful assistant search
    // (recorded inside the search tool handlers), never on authentication
    // or session setup, so connecting does not consume the trial.
    req.user = {
      ...user,
      broker_id: brokerId || user.broker_id || user.id,
      tenant_id: tenantId,
    };
    return next();
  } catch {
    setMcpUnauthorizedHeaders(req, res);
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Client signup: creates a client-only account. Rate limited per IP.
const signupHits = new Map<string, number[]>();
app.post("/client/signup", async (req: Request, res: Response) => {
  const ip = String(req.ip || "unknown");
  const now = Date.now();
  const recent = (signupHits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 10) return res.status(429).json({ error: "Too many attempts. Try again later." });
  recent.push(now);
  signupHits.set(ip, recent);
  try {
    const b = req.body ?? {};
    const result = await signupClient({
      email: String(b.email ?? ""),
      password: String(b.password ?? ""),
      fullName: String(b.full_name ?? ""),
      phone: String(b.phone ?? ""),
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json({ ok: true, message: "Check your email to confirm your account, then connect your assistant." });
  } catch {
    return res.status(500).json({ error: "Could not create the account. Try again later." });
  }
});

app.all("/mcp", authMiddleware, async (req: Request, res: Response) => {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sessionId = req.headers["mcp-session-id"];
  let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (session && !sessionMatchesRequest(session, req)) {
    return res.status(403).json({ error: "Session belongs to a different user" });
  }
  if (typeof sessionId === "string") {
    await touchSessionRecord(sessionId).catch(() => {});
  }

  if (!session) {
    const server = createMcpServer({ user: req.user, publicOnly: req.publicOnly === true, clientOnly: req.clientOnly === true });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (newSessionId) => {
        sessions.set(newSessionId, { server, transport, ownerId: req.user?.id ?? null, publicOnly: req.publicOnly === true, clientOnly: req.clientOnly === true });
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

// Broker raw-message MCP: authenticated only and isolated from the public
// market surface. A separate session map prevents a public /mcp session id
// from being reused against this tenant-scoped endpoint.
const rawSessions = new Map<string, McpSession>();
async function rawAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  return authMiddleware(req, res, () => {
    if (!req.user || req.publicOnly || req.clientOnly) {
      setMcpUnauthorizedHeaders(req, res);
      return res.status(401).json({ error: "Sign in to PropAI to use broker raw-message search" });
    }
    return next();
  });
}

app.all("/raw-mcp", rawAuthMiddleware, async (req: Request, res: Response) => {
  if (!["GET", "POST", "DELETE"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  const sessionId = req.headers["mcp-session-id"];
  let session = typeof sessionId === "string" ? rawSessions.get(sessionId) : undefined;
  if (session && !sessionMatchesRequest(session, req)) {
    return res.status(403).json({ error: "Session belongs to a different user" });
  }
  if (typeof sessionId === "string") await touchSessionRecord(sessionId).catch(() => {});
  if (!session) {
    const server = createRawMcpServer({ user: req.user });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: async (newSessionId) => {
        rawSessions.set(newSessionId, { server, transport, ownerId: req.user?.id ?? null, publicOnly: false });
        await createSessionRecord({ sessionId: newSessionId, userId: req.user?.id, userAgent: String(req.headers["user-agent"] || "") }).catch(() => {});
      },
      onsessionclosed: async (closedSessionId) => {
        const closedSession = rawSessions.get(closedSessionId);
        rawSessions.delete(closedSessionId);
        await closeSessionRecord(closedSessionId).catch(() => {});
        await closedSession?.server.close();
      },
    });
    transport.onclose = async () => {
      if (transport.sessionId) {
        rawSessions.delete(transport.sessionId);
        await closeSessionRecord(transport.sessionId).catch(() => {});
      }
    };
    session = { server, transport };
    await server.connect(transport);
  }
  try {
    await session.transport.handleRequest(req, res, req.method === "POST" ? req.body : undefined);
  } catch (error) {
    console.error("Raw MCP request error:", error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
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

export const httpServer = app.listen(PORT, () => {
  console.log(`PropAI MCP server running on port ${PORT}`);
});

httpServer.on("error", (error) => {
  console.error("Failed to start PropAI MCP server:", error);
  process.exit(1);
});
