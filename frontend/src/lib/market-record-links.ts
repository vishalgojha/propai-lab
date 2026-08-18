import { slugifyEntitySegment } from "@/lib/entity-links";

type MarketRecordLike = {
  id?: string | number;
  latest_parsed_id?: string | number;
  source_schema?: string;
  _typed_table?: string;
  summary_title?: string;
  building_name?: string;
  micro_market?: string;
  location_raw?: string;
  bhk?: string | number;
  configuration?: string;
  intent?: string;
  transaction_type?: string;
};

function cleanTitle(value: unknown) {
  return String(value ?? "")
    .replace(/[\u{1F300}-\u{1FAFF}\u200D\uFE0F]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackTitle(item: MarketRecordLike) {
  const configuration = cleanTitle(item.bhk || item.configuration);
  const place = cleanTitle(item.building_name || item.micro_market || item.location_raw);
  const side = /rent|lease/i.test(String(item.transaction_type || item.intent || "")) ? "rent" : "sale";
  return [configuration, place, `property for ${side}`].filter(Boolean).join(" ");
}

/**
 * Human-readable URL with the typed table as a namespace and the immutable
 * typed-row ID as the identity. The slug is cosmetic and may change safely.
 */
export function marketRecordHref(item: MarketRecordLike, title?: string) {
  const id = item.latest_parsed_id ?? item.id;
  const schema = String(item.source_schema || item._typed_table || "").trim();
  if (id == null || !schema) return null;
  const isRequirement = schema.endsWith("_requirements");
  const kind = isRequirement ? "requirements" : "listings";
  const readable = slugifyEntitySegment(cleanTitle(title || item.summary_title) || fallbackTitle(item)) || kind;
  return `/market/${kind}/${readable}/${encodeURIComponent(schema)}/${encodeURIComponent(String(id))}`;
}

