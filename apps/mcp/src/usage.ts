import { supabase } from "./supabase.ts";

/**
 * Fire-and-forget usage record for a successful assistant search, so real
 * broker usage can be shown separately from automated checks. Records who
 * (workspace only), surface, action and timestamp only -
 * never query text, filters, message content or results.
 *
 * MCP searches reach Supabase directly and never pass through the API, so
 * they are recorded here. Their provenance is unknown by design: origin is
 * always "assistant_unlabeled" and is never presented as human product usage.
 * Bookkeeping failures are logged and never affect the search response.
 */
export function recordSearchUsage(tenantId: string | undefined) {
  if (!tenantId) return;
  const row = {
    tenant_id: tenantId,
    surface: "assistant",
    action: "search",
    origin: "assistant_unlabeled",
  };
  try {
    void Promise.resolve(
      supabase.from("broker_usage_events").insert(row),
    ).then(
      (res: { error?: { message?: string } | null }) => {
        if (res.error) {
          console.warn("Usage event insert failed:", res.error.message);
        }
      },
      (error: unknown) => {
        console.warn("Usage event insert failed:", error instanceof Error ? error.message : error);
      },
    );
  } catch (error) {
    console.warn("Usage event insert failed:", error instanceof Error ? error.message : error);
  }
}
