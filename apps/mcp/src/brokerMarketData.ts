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
 * recorded row with revoked_at null grants the signed-in (organization_id,
 * user_id) pair the cross-search reader role. From
 * 20261121100000_shared_read_default_and_review.sql, a NEW authorization
 * (completed sign-in consent) inserts that grant by default with notice on
 * the approval screen; existing connections are never upgraded silently, and
 * the insert-if-absent rule never resurrects a recorded explicit disable.
 * The reader is the actual signed-in tenant:user, never a fabricated key.
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
 * Live grant check, re-run on every call so an owner disabling access stops
 * the reader immediately (same immediacy as source untick). Requires a
 * recorded, unrevoked grant row. Fail closed on error.
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

/**
 * New-authorization default: grant cross-search read when this (tenant, user)
 * has NO recorded row at all. A recorded enable is left alone and a recorded
 * explicit disable is never resurrected; existing connections are unchanged.
 */
export async function defaultMcpReaderGrantOnNewAuthorization(organizationId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc("broker_market_default_mcp_reader_grant", {
    p_tenant: organizationId,
    p_user: userId,
    p_actor: userId,
  });
  if (error) throw rpcError();
}

export type SharedSourceRow = {
  whatsapp_connection_id: number;
  group_jid: string;
  group_name: string;
  confirmed_at: string;
  message_count: number;
  last_message_at: string | null;
};

/** The reader tenant's OWN current sharing state for review suggestions:
 * identifiers, names, consent time and directory counters. Never content. */
export async function marketSharedSources(tenantId: string): Promise<SharedSourceRow[]> {
  const { data, error } = await supabase.rpc("broker_market_shared_sources", { p_tenant: tenantId });
  if (error) throw rpcError();
  return (data || []) as SharedSourceRow[];
}
