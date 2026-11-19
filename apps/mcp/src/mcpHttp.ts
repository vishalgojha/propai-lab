import crypto from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { createMcpServer } from "./index.js";
import { sessionAccessAllowed, sessionOwnerFor, type SessionOwner } from "./mcpAccess.js";

export type McpSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  owner: SessionOwner;
};

export type McpHandlerDeps = {
  sessions: Map<string, McpSession>;
  /** May be async (the raw broker route resolves the reader's property cross-search grant before building the toolset). Awaiting a sync factory is a no-op. */
  createServer: (context: { user?: Request["user"]; publicOnly: boolean }) => ReturnType<typeof createMcpServer> | Promise<ReturnType<typeof createMcpServer>>;
  challenge: (req: Request, res: Response) => void;
  records: {
    create: (input: { sessionId: string; userId?: string | null; userAgent?: string | null }) => Promise<unknown>;
    touch: (sessionId: string) => Promise<unknown>;
    close: (sessionId: string) => Promise<unknown>;
  };
};

export function createMcpHandler(deps: McpHandlerDeps) {
  const { sessions, records } = deps;
  return async function handleMcp(req: Request, res: Response) {
    if (!["GET", "POST", "DELETE"].includes(req.method)) {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const sessionId = req.headers["mcp-session-id"];
    let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (session && !sessionAccessAllowed(session.owner, req)) {
      // A session id alone never grants access to a signed-in user's session.
      deps.challenge(req, res);
      return res.status(401).json({ error: "Session does not belong to this sign-in" });
    }
    if (session && typeof sessionId === "string") {
      await records.touch(sessionId).catch(() => {});
    }

    if (!session) {
      const owner = sessionOwnerFor(req);
      const server = await deps.createServer({ user: req.user, publicOnly: req.publicOnly === true });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: async (newSessionId) => {
          sessions.set(newSessionId, { server, transport, owner });
          await records.create({
            sessionId: newSessionId,
            userId: req.user?.id,
            userAgent: String(req.headers["user-agent"] || ""),
          }).catch(() => {});
        },
        onsessionclosed: async (closedSessionId) => {
          const closedSession = sessions.get(closedSessionId);
          sessions.delete(closedSessionId);
          await records.close(closedSessionId).catch(() => {});
          await closedSession?.server.close();
        },
      });

      transport.onclose = async () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          await records.close(transport.sessionId).catch(() => {});
        }
      };

      session = { server, transport, owner };
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
  };
}
