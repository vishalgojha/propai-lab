import type { Express, Request, Response } from "express";
import { createAuthMiddleware, type AccessDeps } from "./mcpAccess.ts";
import { createMcpHandler, type McpSession } from "./mcpHttp.ts";
import { createRawBrokerMcpServerWithMarket } from "./rawBrokerServer.ts";

export const RAW_MCP_PATH = "/raw-mcp";
export const RAW_MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/raw-mcp";

/**
 * Mounts the isolated raw endpoint with its OWN session map, so a session id issued by the legacy /mcp
 * endpoint can never reach this server (nor the reverse). Sign-in is required; there is no public mode.
 */
export function mountRawBrokerRoute(app: Express, deps: {
  access: AccessDeps;
  challenge: (req: Request, res: Response, metadataPath: string) => void;
  records: Parameters<typeof createMcpHandler>[0]["records"];
  metadata: (req: Request, res: Response, resourcePath: string) => unknown;
}) {
  const sessions = new Map<string, McpSession>();
  const challenge = (req: Request, res: Response) => deps.challenge(req, res, RAW_MCP_METADATA_PATH);
  const handler = createMcpHandler({
    sessions,
    createServer: (ctx) => createRawBrokerMcpServerWithMarket({ user: ctx.user } as never) as never,
    challenge,
    records: deps.records,
  });
  app.all(RAW_MCP_PATH, createAuthMiddleware("workspace", { ...deps.access, challenge: challenge as never }), handler);
  app.get(RAW_MCP_METADATA_PATH, (req, res) => deps.metadata(req, res, RAW_MCP_PATH));
  return sessions;
}
