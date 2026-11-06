import crypto from "node:crypto";

export type ListingBroker = { name: string | null; phone: string | null; firm: string | null };

export type NormalizedListing = {
  listing_id: string;
  transaction_type: "rent" | "sale" | "lease" | null;
  building: string | null;
  locality: string | null;
  micro_market: string | null;
  road: string | null;
  bhk: number | null;
  carpet_sqft: number | null;
  floor: string | null;
  furnishing: string | null;
  car_parks: number | null;
  rent_monthly_inr: number | null;
  rent_range_monthly_inr: { min: number; max: number } | null;
  sale_price_inr: number | null;
  rent_negotiable: boolean | null;
  final_price: boolean | null;
  deposit: string | null;
  brokerage_terms: string | null;
  pets_allowed: boolean | null;
  community_restrictions: string | null;
  possession: string | null;
  deal_type: "direct" | "side_by_side" | null;
  first_seen: string | null;
  last_seen: string | null;
  repost_count: number;
  source_groups: string[];
  brokers: ListingBroker[];
  source_message_ids: string[];
  source_message_id: string;
  source_group_name: string | null;
  raw_message: string;
  confidence: Record<string, "source" | "inferred" | "ambiguous" | "missing">;
  location_confidence: "high" | "medium" | "ambiguous" | "low";
  revised_quote: boolean;
};

const BANDRA_ALIASES: Array<[RegExp, string]> = [
  [/\bpali\s+hill\b|\bpali\s+naka\b/i, "Pali Hill"],
  [/\bhill\s+road\b/i, "Hill Road"],
  [/\bcarter\s+road\b/i, "Carter Road"],
  [/\bmount\s+mary\b/i, "Mount Mary"],
  [/\balmeida\s+park\b/i, "Almeida Park"],
  [/\bperry\s+cross\b/i, "Perry Cross"],
  [/\brizvi\s+complex\b/i, "Rizvi Complex"],
  [/\bsherly\s+rajan(?:\s+rd|\s+road)?\b/i, "Sherly Rajan Road"],
  [/\bkantwadi\b/i, "Kantwadi"],
  [/\bturner\s+rd\b|\bturner\s+road\b/i, "Turner Road"],
  [/\bwaroda\b/i, "Waroda"],
  [/\branwar\b/i, "Ranwar"],
];

const BUILDING_ALIASES: Array<[RegExp, string]> = [
  [/\bbeau\s*pride\b/i, "Beau Pride"],
  [/\bdeepak\s+silver(?:ing|line)\b/i, "Deepak Silvering"],
  [/\bizz?arra\b/i, "Izzara"],
];

function clean(value: unknown) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function normalizedText(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function number(value: string | number | null | undefined) {
  if (value == null) return null;
  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeIndianRent(raw: string, rentContext = true): number | null {
  const text = String(raw || "").replace(/₹/g, "").replace(/rs\.?|inr/gi, "").trim();
  const match = text.match(/(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l|thousands?|k)?/i);
  if (!match) return null;
  const amount = number(match[1]);
  if (amount == null) return null;
  const unit = String(match[2] || "").toLowerCase();
  if (/crore|cr/.test(unit)) return Math.round(amount * 10_000_000);
  if (/lakh|lac|^l$/.test(unit)) return Math.round(amount * 100_000);
  if (/thousand|^k$/.test(unit)) {
    // Rental WhatsApp posts frequently write 3.60K when they mean 3.60L.
    if (rentContext && amount > 1 && amount < 20) return Math.round(amount * 100_000);
    return Math.round(amount * 1_000);
  }
  return Math.round(amount);
}

function moneyRange(text: string, rentContext: boolean) {
  const matches = [...text.matchAll(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l|thousands?|k)\b/gi)]
    .map((match) => normalizeIndianRent(`${match[1]} ${match[2]}`, rentContext))
    .filter((value): value is number => value != null);
  if (!matches.length) return { value: null, range: null };
  const unique = [...new Set(matches)].sort((a, b) => a - b);
  return {
    value: unique[unique.length - 1],
    range: unique.length > 1 ? { min: unique[0], max: unique[unique.length - 1] } : null,
  };
}

function transaction(text: string): "rent" | "sale" | "lease" | null {
  if (/\b(?:rent|rental|monthly|per\s*month|tenant|deposit|leave\s*(?:&|and)\s*license|l&l|pkg)\b/i.test(text)) {
    return /\blease\b|leave\s*(?:&|and)\s*license|\bl&l\b/i.test(text) ? "lease" : "rent";
  }
  if (/\b(?:sale|sell|outright|resale|purchase|asking\s+price)\b|\b\d+(?:\.\d+)?\s*(?:cr|crore|crores)\b/i.test(text)) return "sale";
  return null;
}

function findAlias(text: string, aliases: Array<[RegExp, string]>) {
  return aliases.find(([pattern]) => pattern.test(text))?.[1] || null;
}

function localityFor(text: string) {
  const lower = text.toLowerCase();
  const explicitBandra = /\bbandra\s+west\b/i.test(text);
  const ambiguous = explicitBandra && (/\bkhar\s+west\b/i.test(text) || /\b(?:14th|18th)\s+road\b/i.test(text) || /\brustomjee\s+paramount\b/i.test(text));
  const micro = findAlias(text, BANDRA_ALIASES);
  if (ambiguous) return { locality: "Bandra West", micro, confidence: "ambiguous" as const };
  if (explicitBandra) return { locality: "Bandra West", micro, confidence: micro ? "high" as const : "high" as const };
  const match = text.match(/\b(?:in|at|near|off|on)\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})/);
  return { locality: clean(match?.[1]), micro, confidence: micro ? "medium" as const : "low" as const };
}

function splitBroadcast(text: string) {
  const source = String(text || "").trim();
  const starts = [...source.matchAll(/(?:^|\n)\s*(?:\*?\s*)?(\d{1,2})\s*[.)-]\s+/g)];
  if (starts.length < 2) return [{ index: 0, text: source }];
  const prefix = source.slice(0, starts[0].index ?? 0).trim();
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? source.length;
    const block = source.slice(start, end).trim();
    const withPrefix = prefix && prefix.length < 240 ? `${prefix}\n${block}` : block;
    return { index: Number(match[1]), text: withPrefix };
  });
}

function parseBlock(input: { rawId: string; group: string | null; timestamp: string | null; sender: string | null; phone: string | null; text: string; index: number }): NormalizedListing {
  const text = input.text;
  const tx = transaction(text);
  const rent = tx === "rent" || tx === "lease";
  const local = localityFor(text);
  const lineBuilding = text.match(/(?:^|\n)\s*(?:\d{1,2}[.)-]\s*)?[*_]*([^\n|–—-]{2,60})[*_]*\s*[-–—@]\s*(?:Bandra|Khar|Pali|Hill|Mount|Almeida|Carter|Rizvi|Sherly)/i)?.[1];
  const building = findAlias(text, BUILDING_ALIASES) || clean(lineBuilding);
  const bhk = number(text.match(/\b(\d+(?:\.\d+)?)\s*(?:bhk|bhd|bed(?:room)?s?)\b/i)?.[1]);
  const area = number((text.match(/(?:carpet|area|size)\s*(?:is|:|-)?\s*(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|sft)/i)?.[1] || text.match(/\b(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|sft)\b/i)?.[1] || "").replace(/,/g, ""));
  const floor = clean(text.match(/\b(?:on|at)\s+(?:the\s+)?(\d+(?:st|nd|rd|th)?|ground|lower|middle|higher|high)\s+floor\b/i)?.[1]);
  const furnishing = clean(text.match(/\b(fully\s+furnished|furnished|semi[- ]?furnished|unfurnished)\b/i)?.[1]);
  const carParks = number(text.match(/\b(\d+)\s*(?:car\s*)?(?:park(?:ing)?|car\s*parks?)\b/i)?.[1]);
  const deposit = clean(text.match(/(?:deposit|security)\s*(?:of|:)?\s*([^,;\n]+)/i)?.[1]);
  const brokerage = clean(text.match(/(?:brokerage|brok(?:erage)?|side\s*by\s*side)\s*[:\-]?\s*([^,;\n]+)/i)?.[1]);
  const possession = clean(text.match(/(?:possession|available|move[- ]?in)\s*(?:from|:)?\s*([^,;\n]+)/i)?.[1]);
  const restriction = clean(text.match(/\b(?:hindus?\s+only|muslim\s+famil(?:y|ies)|all\s+communities|open\s+to\s+all\s+communities|no\s+restriction[^,;\n]*)\b/i)?.[0]);
  const revised = /\b(?:revised\s+quote|price\s+revised|revised\s+price|revised)\b/i.test(text);
  const money = moneyRange(text, rent);
  const phone = clean(input.phone || text.match(/(?:\+?91[-\s]?)?[6-9]\d{9}\b/)?.[0]);
  const sender = clean(input.sender);
  const direct = /\bdirect\b/i.test(text) ? "direct" : /side\s*by\s*side/i.test(text) ? "side_by_side" : null;
  const id = `${input.rawId}:${input.index}`;
  return {
    listing_id: id,
    transaction_type: tx,
    building,
    locality: local.locality,
    micro_market: local.micro,
    road: clean(text.match(/\b(?:\d{1,2}(?:st|nd|rd|th)?\s+road|[A-Z][A-Za-z]+\s+(?:Road|Rd))\b/i)?.[0]),
    bhk,
    carpet_sqft: area,
    floor,
    furnishing,
    car_parks: carParks,
    rent_monthly_inr: rent ? money.value : null,
    rent_range_monthly_inr: rent ? money.range : null,
    sale_price_inr: tx === "sale" ? money.value : null,
    rent_negotiable: rent ? (/\b(?:negotiable|nego)\b/i.test(text) ? true : /\bnon[- ]?negotiable\b/i.test(text) ? false : null) : null,
    final_price: /\b(?:final|fixed|non[- ]?negotiable)\b/i.test(text) ? true : null,
    deposit,
    brokerage_terms: brokerage,
    pets_allowed: /\bpets?\s+allowed\b/i.test(text) ? true : /\bno\s+pets?\b|\bpets?\s+not\s+allowed\b/i.test(text) ? false : null,
    community_restrictions: restriction,
    possession,
    deal_type: direct,
    first_seen: input.timestamp,
    last_seen: input.timestamp,
    repost_count: 1,
    source_groups: input.group ? [input.group] : [],
    brokers: [{ name: sender, phone, firm: null }],
    source_message_ids: [input.rawId],
    source_message_id: input.rawId,
    source_group_name: input.group,
    raw_message: text,
    confidence: {
      transaction_type: tx ? "source" : "missing",
      building: building ? "source" : "missing",
      locality: local.confidence === "ambiguous" ? "ambiguous" : local.locality ? "source" : "missing",
      rent_monthly_inr: money.value != null ? "source" : "missing",
      bhk: bhk != null ? "source" : "missing",
    },
    location_confidence: local.confidence,
    revised_quote: revised,
  };
}

export function parseRawMessageListing(input: { rawId: string | number; group?: string | null; timestamp?: string | null; sender?: string | null; phone?: string | null; text: string }) {
  return splitBroadcast(input.text).map((part) => parseBlock({ ...input, rawId: String(input.rawId), group: input.group || null, timestamp: input.timestamp || null, sender: input.sender || null, phone: input.phone || null, text: part.text, index: part.index }));
}

function clusterKey(row: NormalizedListing) {
  const base = [normalizedText(row.building), normalizedText(row.locality), row.bhk ?? "", row.carpet_sqft ?? "", normalizedText(row.floor)].join("|");
  if (base.replace(/[|]/g, "")) return base;
  return `source:${row.source_message_id}`;
}

function mergeBroker(target: ListingBroker[], broker: ListingBroker) {
  const key = `${normalizedText(broker.name)}|${String(broker.phone || "").replace(/\D/g, "").slice(-10)}`;
  if (key === "|") return target;
  if (!target.some((item) => `${normalizedText(item.name)}|${String(item.phone || "").replace(/\D/g, "").slice(-10)}` === key)) target.push(broker);
  return target;
}

export function clusterNormalizedListings(rows: NormalizedListing[]) {
  const clusters = new Map<string, NormalizedListing>();
  for (const row of rows) {
    const key = clusterKey(row);
    const existing = clusters.get(key);
    if (!existing) {
      clusters.set(key, { ...row, listing_id: `cluster:${crypto.createHash("sha1").update(key).digest("hex").slice(0, 12)}` });
      continue;
    }
    const timestamps = [existing.first_seen, row.first_seen].filter(Boolean).sort();
    existing.first_seen = timestamps[0] || null;
    existing.last_seen = [existing.last_seen, row.last_seen].filter(Boolean).sort().at(-1) || null;
    existing.repost_count += row.repost_count;
    existing.source_message_ids = [...new Set([...existing.source_message_ids, ...row.source_message_ids])];
    existing.source_groups = [...new Set([...existing.source_groups, ...row.source_groups])];
    existing.brokers = mergeBroker(existing.brokers, row.brokers[0] || { name: null, phone: null, firm: null });
    if (row.revised_quote) {
      existing.rent_monthly_inr = row.rent_monthly_inr;
      existing.rent_range_monthly_inr = null;
      existing.revised_quote = true;
    } else {
      existing.rent_monthly_inr = existing.rent_monthly_inr || row.rent_monthly_inr;
      const rents = [existing.rent_monthly_inr, row.rent_monthly_inr].filter((value): value is number => value != null).sort((a, b) => a - b);
      existing.rent_range_monthly_inr = rents.length > 1 ? { min: rents[0], max: rents[rents.length - 1] } : existing.rent_range_monthly_inr;
    }
    if (row.revised_quote) existing.raw_message = row.raw_message;
    if (existing.location_confidence !== "ambiguous") existing.location_confidence = row.location_confidence;
  }
  return [...clusters.values()].sort((a, b) => String(b.last_seen || "").localeCompare(String(a.last_seen || "")));
}

export function filterNormalizedListings(rows: NormalizedListing[], filters: {
  locality?: string;
  transaction_type?: "rent" | "sale" | "lease" | "all";
  bhk?: number;
  budget_min_inr?: number;
  budget_max_inr?: number;
  furnishing?: string;
  min_car_parks?: number;
  pets_allowed?: boolean;
  community_restrictions?: string;
  deal_type?: "direct" | "side_by_side";
  min_last_seen?: string;
}) {
  const locality = normalizedText(filters.locality);
  return rows.filter((row) => {
    const haystack = normalizedText([row.locality, row.micro_market, row.building, row.road].filter(Boolean).join(" "));
    if (locality && !haystack.includes(locality)) return false;
    if (filters.transaction_type && filters.transaction_type !== "all" && row.transaction_type !== filters.transaction_type) return false;
    if (filters.bhk != null && row.bhk !== filters.bhk) return false;
    const price = row.rent_monthly_inr ?? row.sale_price_inr;
    if (filters.budget_min_inr != null && (price == null || price < filters.budget_min_inr)) return false;
    if (filters.budget_max_inr != null && (price == null || price > filters.budget_max_inr)) return false;
    if (filters.furnishing && normalizedText(row.furnishing) !== normalizedText(filters.furnishing)) return false;
    if (filters.min_car_parks != null && (row.car_parks == null || row.car_parks < filters.min_car_parks)) return false;
    if (filters.pets_allowed != null && row.pets_allowed !== filters.pets_allowed) return false;
    if (filters.community_restrictions && !normalizedText(row.community_restrictions).includes(normalizedText(filters.community_restrictions))) return false;
    if (filters.deal_type && row.deal_type !== filters.deal_type) return false;
    if (filters.min_last_seen && (!row.last_seen || row.last_seen < filters.min_last_seen)) return false;
    return true;
  });
}

export function sortNormalizedListings(rows: NormalizedListing[], sort: "recency" | "rent" | "relevance" = "recency") {
  return [...rows].sort((a, b) => {
    if (sort === "rent") return (a.rent_monthly_inr ?? Number.MAX_SAFE_INTEGER) - (b.rent_monthly_inr ?? Number.MAX_SAFE_INTEGER);
    return String(b.last_seen || "").localeCompare(String(a.last_seen || ""));
  });
}
