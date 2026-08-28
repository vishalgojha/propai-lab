type PublicPayload = Record<string, unknown>;

export type PublicEligibilityRow = {
  summary_title?: string | null;
  raw_payload?: unknown;
  asset_type?: string | null;
  property_type?: string | null;
};

function sourceText(payload: PublicPayload | null): string {
  if (!payload) return "";
  return [payload.full_text, payload.slice_text, payload.normalized_message]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function hasUnresolvedCommercialConflict(row: PublicEligibilityRow, payload: PublicPayload | null): boolean {
  if (String(row.asset_type ?? "").trim().toLowerCase() !== "residential") return false;
  const source = sourceText(payload);
  if (!source) return false;
  const commercial = /\b(?:office|shop|showroom|warehouse|godown|commercial|industrial\s+(?:estate|building|premises)|bare\s*shell|warm\s*shell|plug[- ]and[- ]play|chargeable\s+area|ceiling\s+height|mezzanine|cabin|workstation|conference\s+room|power\s+load)\b/i.test(source);
  const explicitResidential = /\b(?:flat|apartment|residential|villa|bungalow|independent\s+(?:house|home))\b/i.test(source);
  return commercial && !explicitResidential;
}

/** Shared publication gate for every public listing surface. */
export function isPublicListingEligible(row: PublicEligibilityRow): boolean {
  const payload = row.raw_payload && typeof row.raw_payload === "object" && !Array.isArray(row.raw_payload)
    ? row.raw_payload as PublicPayload
    : null;
  if (payload?.public_eligible === false) return false;
  if (hasUnresolvedCommercialConflict(row, payload)) return false;
  const title = String(row.summary_title ?? "").trim();
  return Boolean(title) && !/^\[(?:unstructured|unknown|listing)\]/i.test(title);
}
