type PublicPayload = Record<string, unknown>;

export type PublicEligibilityRow = {
  summary_title?: string | null;
  raw_payload?: unknown;
};

/** Shared publication gate for every public listing surface. */
export function isPublicListingEligible(row: PublicEligibilityRow): boolean {
  const payload = row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
    ? row.raw_payload as PublicPayload
    : null;
  if (payload?.public_eligible === false) return false;
  const title = String(row.summary_title ?? "").trim();
  return Boolean(title) && !/^\[(?:unstructured|unknown|listing)\]/i.test(title);
}
