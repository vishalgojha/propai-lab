import { supabase } from "./supabase.ts";

/**
 * Data access for broker property cross-search on the existing broker MCP.
 * Uses exactly the reviewed SQL surface (migration
 * 20261119090000_broker_property_cross_search.sql): broker_market_search,
 * broker_market_get and broker_market_take_rate. Source eligibility, consent
 * revocation and forward-only scoping are enforced in SQL; this module adds no
 * alternate policy implementation and never falls back to unscoped queries.
 *
 * Reader enablement is the owner-controlled broker_market_mcp_reader_grants
 * table (migration 20261119100000_broker_market_mcp_reader_grants.sql): a
 * workspace owner grants their own MCP sign-in (organization_id, user_id) the
 * cross-search reader role. There is no automatic upgrade for existing
 * connections and no fabricated REST key.
 */

export type MarketRow = {
  raw_id: number;
  body: string;
  posted_at: string;
  sender_phone: string | null;
  sender_jid: string | null;
};

/** Fail closed: a source/RPC problem never widens into another access path. */
function rpcError(): Error {
  return new Error("Broker market source access is temporarily unavailable");
}

export async function marketSearch(params: {
  terms: string[][];
  propertyPattern: string;
  since: string;
  until: string;
  limit: number;
  lastId: number | null;
  lastAt: string | null;
}): Promise<MarketRow[]> {
  const { data, error } = await supabase.rpc("broker_market_search", {
    p_terms: params.terms,
    p_property_pattern: params.propertyPattern,
    p_since: params.since,
    p_until: params.until,
    p_limit: params.limit,
    p_last_id: params.lastId,
    p_last_at: params.lastAt,
  });
  if (error) throw rpcError();
  return (data || []) as MarketRow[];
}

export async function marketGet(rawId: number): Promise<MarketRow[]> {
  const { data, error } = await supabase.rpc("broker_market_get", { p_raw_id: rawId });
  if (error) throw rpcError();
  return (data || []) as MarketRow[];
}

/** Cross-worker hourly caps (search/get 60, contact 10), keyed by reader. */
export async function marketTakeRate(reader: string, operation: "search" | "get" | "contact"): Promise<boolean> {
  const { data, error } = await supabase.rpc("broker_market_take_rate", { p_reader: reader, p_operation: operation });
  if (error) throw rpcError();
  return data === true;
}

/**
 * Live grant check, re-run on every call so an owner revoking access stops the
 * reader immediately (same immediacy as source untick). Fail closed on error.
 */
export async function mcpReaderGrantActive(organizationId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("broker_market_mcp_reader_grants")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw rpcError();
  return Boolean(data);
}
