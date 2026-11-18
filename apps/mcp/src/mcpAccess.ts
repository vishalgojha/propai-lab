import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedUser } from "./types.js";

/**
 * Access rules for the MCP HTTP routes.
 *
 * - "public-or-user" (/mcp): no token means the account-free public toolset;
 *   a presented token is strictly verified and gives the tenant toolset.
 * - "workspace" (/mcp/workspace): a verified token with tenant membership is
 *   required on every request. No token answers 401 plus an OAuth challenge so
 *   MCP clients start the PropAI sign-in; it never falls back to public tools.
 *
 * Sessions created for a signed-in user are bound to that user and tenant and
 * are re-checked on every request, so a session id alone never grants access.
 */
export type AccessMode = "public-or-user" | "workspace";

export type AccessDeps = {
  verify: (token: string) => Promise<AuthenticatedUser>;
  resolveBrokerId: (user: AuthenticatedUser) => Promise<string | null | undefined>;
  resolveTenantId: (user: AuthenticatedUser) => Promise<string | null | undefined>;
  challenge: (req: Request, res: Response, mode: AccessMode) => void;
};

export type SessionOwner = { userId: string; tenantId: string; brokerId: string } | undefined;

export function bearerToken(req: Request): string {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
}

export function createAuthMiddleware(mode: AccessMode, deps: AccessDeps) {
  return async function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const token = bearerToken(req);
    if (!token) {
      if (mode === "workspace") {
        deps.challenge(req, res, mode);
        return res.status(401).json({ error: "Sign in to PropAI to use workspace search" });
      }
      req.publicOnly = true;
      return next();
    }
    try {
      const user = await deps.verify(token);
      const brokerId = await deps.resolveBrokerId(user);
      const tenantId = await deps.resolveTenantId(user);
      if (!tenantId) {
        deps.challenge(req, res, mode);
        return res.status(403).json({ error: "Tenant membership is required" });
      }
      req.user = { ...user, broker_id: brokerId || user.broker_id || user.id, tenant_id: tenantId };
      return next();
    } catch {
      deps.challenge(req, res, mode);
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

/** Owner recorded when a session is created for a signed-in user. */
export function sessionOwnerFor(req: Request): SessionOwner {
  const user = req.user;
  if (!user || req.publicOnly === true || !user.tenant_id) return undefined;
  return { userId: user.id, tenantId: user.tenant_id, brokerId: String(user.broker_id || user.id) };
}

/** True when this request may use an existing session. */
export function sessionAccessAllowed(owner: SessionOwner, req: Request): boolean {
  if (!owner) return true; // public session: nothing private behind it
  const user = req.user;
  return Boolean(
    user &&
      req.publicOnly !== true &&
      user.id === owner.userId &&
      user.tenant_id === owner.tenantId &&
      String(user.broker_id || user.id) === owner.brokerId,
  );
}
