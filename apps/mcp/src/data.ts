import crypto from "node:crypto";
import { supabase } from "./supabase.ts";
import { formatBudgetRange, formatCurrencyCr, formatPerSqft, listingLabel, toNumber, formatSqft } from "./format.ts";
import type { PublicListing } from "./types.js";

export const PUBLIC_LISTING_COLUMNS =
  "source_message_id, source_group_name, listing_type, area, sub_area, location, price, price_type, size_sqft, furnishing, bhk, property_type, title, description, raw_message, cleaned_message, primary_contact_name, primary_contact_number, primary_contact_wa, message_timestamp";
const PARSED_MARKET_COLUMNS =
  "id, raw_message_id, listing_index, message_type, intent, bhk, price, price_unit, area_sqft, furnishing, location_raw, area, micro_market, building_name, broker_name, broker_phone, profile_name, raw_payload, summary_title, created_at, raw_messages(group_name, sender, sender_phone, message, timestamp)";
const PLACEHOLDER_LOCALITIES = new Set([
  "unknown",
  "mumbai market",
  "mumbai",
  "navi mumbai",
  "thane",
  "pune",
]);

function clampLimit(limit: number | undefined, fallback = 10, max = 50) {
  if (!limit || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), max);
}

function normalizeListingText(value: string | null | undefined) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseMaybeJson(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeParsedPrice(value: unknown, unit: unknown) {
  const price = toNumber(value);
  if (price == null) return null;
  const normalizedUnit = String(unit || "").toLowerCase().replace(/[^a-z]/g, "");
  if (["cr", "crore", "crores"].includes(normalizedUnit)) return price * 10_000_000;
  if (["lac", "lakh", "lakhs", "l"].includes(normalizedUnit)) return price * 100_000;
  if (["k", "thousand"].includes(normalizedUnit)) return price * 1_000;
  return price;
}

function parseBhk(value: unknown) {
  if (value == null) return null;
  const direct = toNumber(value);
  if (direct != null) return direct;
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? toNumber(match[0]) : null;
}

function inferListingTypeFromParsed(row: Record<string, unknown>, rawText: string) {
  const text = [
    row.intent,
    row.message_type,
    row.price_unit,
    row.summary_title,
    rawText,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/(requirement|wanted|looking|need|tenant|buyer|rent req|lease req)/.test(text)) return "requirement";
  if (/(rent|lease|monthly|tenant)/.test(text)) return "listing_rent";
  if (/(sale|sell|outright|resale|distress|auction|cr\b|crore)/.test(text)) return "listing_sale";
  return "listing";
}

function parsedSourceId(row: Record<string, unknown>) {
  const rawId = String(row.raw_message_id || row.id || "");
  const index = Number.isFinite(Number(row.listing_index)) ? Number(row.listing_index) : 0;
  return `${rawId}:${index}`;
}

function sourceIdParts(listingId: string) {
  const [rawId, index] = String(listingId).split(":");
  return {
    rawId: rawId && /^\d+$/.test(rawId) ? Number(rawId) : null,
    index: index != null && /^\d+$/.test(index) ? Number(index) : null,
  };
}

function mapParsedRowToPublicListing(row: Record<string, unknown>): PublicListing {
  const rawMessage = Array.isArray(row.raw_messages) ? row.raw_messages[0] : row.raw_messages;
  const raw = rawMessage && typeof rawMessage === "object" ? rawMessage as Record<string, unknown> : {};
  const payload = parseMaybeJson(row.raw_payload);
  const fullText = firstString(
    payload.full_text,
    payload.text,
    payload.message,
    row.summary_title,
    raw.message,
  );
  const locality = firstString(row.micro_market, row.location_raw, row.area, row.building_name);
  const title = firstString(row.summary_title, row.building_name, fullText?.split(/\r?\n/)[0]);
  const brokerName = firstString(row.broker_name, row.profile_name, raw.sender);
  const brokerPhone = firstString(row.broker_phone, raw.sender_phone);
  const listingType = inferListingTypeFromParsed(row, fullText || "");

  return {
    source_message_id: parsedSourceId(row),
    source_group_name: firstString(raw.group_name),
    listing_type: listingType,
    area: firstString(row.area, row.micro_market, row.location_raw),
    sub_area: locality,
    location: locality,
    price: normalizeParsedPrice(row.price, row.price_unit),
    price_type: firstString(row.price_unit),
    size_sqft: toNumber(row.area_sqft),
    furnishing: firstString(row.furnishing),
    bhk: parseBhk(row.bhk),
    property_type: listingType === "listing_rent" ? "rent" : listingType === "listing_sale" ? "sale" : null,
    title,
    description: fullText,
    raw_message: fullText,
    cleaned_message: fullText,
    primary_contact_name: brokerName,
    primary_contact_number: brokerPhone,
    primary_contact_wa: brokerPhone,
    message_timestamp: firstString(raw.timestamp, row.created_at),
    created_at: firstString(row.created_at),
  };
}

function normalizeIndianPhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  const lastTen = digits.length >= 10 ? digits.slice(-10) : "";
  if (!/^[6-9]\d{9}$/.test(lastTen)) {
    return null;
  }
  return `91${lastTen}`;
}

function inferPublicDealType(row: PublicListing) {
  const lower = [
    row.listing_type,
    row.property_type,
    row.price_type,
    row.title,
    row.description,
    row.raw_message,
  ].filter(Boolean).join(" ").toLowerCase();

  if (lower.includes("requirement")) return "requirement";
  if (lower.includes("rent") || lower.includes("lease") || lower.includes("monthly")) return "rent";
  if (lower.includes("sale") || lower.includes("outright")) return "sale";
  return "unknown";
}

function normalizePublicListingRow(row: PublicListing): PublicListing | null {
  const locality = normalizeListingText(String(row.sub_area || row.area || row.location || ""));
  if (!locality || PLACEHOLDER_LOCALITIES.has(locality)) {
    return null;
  }

  const dealType = inferPublicDealType(row);
  const price = row.price;
  if (price != null && Number.isFinite(price) && price > 0) {
    if (dealType === "rent" && price > 5_000_000) return null;
    if (dealType === "rent" && price < 5_000) return null;
    if (dealType === "sale" && price > 500_000_000) return null;
    if (dealType === "unknown") {
      if (price > 100_000_000) return null;
      if (price < 5_000) return null;
    }
  }

  const normalizedPhone = normalizeIndianPhone(row.primary_contact_wa || row.primary_contact_number);
  return {
    ...row,
    primary_contact_number: normalizedPhone,
    primary_contact_wa: normalizedPhone,
  };
}

function dedupePublicListings(rows: PublicListing[]) {
  const seen = new Set<string>();
  const deduped: PublicListing[] = [];

  for (const row of rows) {
    const key = [
      inferPublicDealType(row),
      normalizeListingText(row.sub_area || row.area || row.location),
      normalizeListingText(row.title || listingLabel(row)),
      normalizeListingText(String(row.bhk || "")),
      String(Math.round(Number(row.price || 0))),
      normalizeListingText(row.primary_contact_wa || row.primary_contact_number || ""),
      normalizeListingText(row.raw_message || "").slice(0, 180),
    ].join("|");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  return deduped;
}

export function normalizePublicListings(rows: unknown[]) {
  return dedupePublicListings(
    (rows as any[])
      .map((row) => ({
        ...row,
        price: toNumber(row.price),
        size_sqft: toNumber(row.size_sqft),
        bhk: toNumber(row.bhk),
      }) as PublicListing)
      .map((row) => normalizePublicListingRow(row))
      .filter((row): row is PublicListing => Boolean(row)),
  );
}

function applyLocality(query: any, locality?: string, city?: string) {
  const terms = [locality, city].map((value) => value?.trim()).filter(Boolean) as string[];
  for (const term of terms) {
    query = query.or(`area.ilike.%${term}%,sub_area.ilike.%${term}%,location.ilike.%${term}%`);
  }
  return query;
}

function applyBudget(query: any, maxBudgetCr?: number) {
  if (maxBudgetCr == null) return query;
  const maxAbsolute = maxBudgetCr * 10_000_000;
  return query.lte("price", maxAbsolute);
}

const DEAL_TYPE_MAP: Record<string, string> = {
  rent: "listing_rent",
  lease: "listing_rent",
  sale: "listing_sale",
};

function applyListingType(query: any, requested?: string, fallback?: string) {
  const type = requested === "all" ? undefined : requested || fallback;
  if (!type) return query;
  const exact = DEAL_TYPE_MAP[type];
  if (exact) {
    return query.eq("listing_type", exact);
  }
  return query.or(`listing_type.ilike.%${type}%,property_type.ilike.%${type}%`);
}

function filterPublicListingRows(rows: PublicListing[], input: {
  locality?: string;
  city?: string;
  property_type?: "sale" | "rent" | "lease" | "all";
  bhk?: number;
  max_budget_cr?: number;
  budget_min_cr?: number;
  budget_max_cr?: number;
  listingKind?: "listing" | "requirement";
}) {
  const terms = [input.locality, input.city].map((value) => normalizeListingText(value)).filter(Boolean);
  const propertyType = input.property_type === "lease" ? "rent" : input.property_type;
  const maxBudget = input.max_budget_cr ?? input.budget_max_cr;

  return rows.filter((row) => {
    const haystack = normalizeListingText([
      row.area,
      row.sub_area,
      row.location,
      row.title,
      row.description,
      row.raw_message,
      row.source_group_name,
    ].filter(Boolean).join(" "));
    if (terms.length && !terms.every((term) => haystack.includes(term))) return false;

    const dealType = inferPublicDealType(row);
    if (input.listingKind === "requirement" && dealType !== "requirement") return false;
    if (input.listingKind === "listing" && dealType === "requirement") return false;
    if (propertyType && propertyType !== "all" && dealType !== propertyType) return false;
    if (input.bhk != null && row.bhk !== input.bhk) return false;
    if (maxBudget != null && row.price != null && row.price > maxBudget * 10_000_000) return false;
    if (input.budget_min_cr != null && row.price != null && row.price < input.budget_min_cr * 10_000_000) return false;
    return true;
  });
}

async function fetchParsedMarketRows(limit: number, since?: string) {
  let query = supabase
    .from("parsed_output")
    .select(PARSED_MARKET_COLUMNS)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (since) {
    query = query.gte("created_at", since);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data || []) as Record<string, unknown>[]).map(mapParsedRowToPublicListing);
}

export async function logToolCall(brokerId: string | undefined, toolName: string, input: unknown) {
  console.log(JSON.stringify({ event: "mcp_tool_call", broker_id: brokerId || null, tool: toolName }));

  try {
    await supabase.from("agent_events").insert({
      tenant_id: brokerId,
      event_type: "mcp_tool_call",
      description: `MCP tool called: ${toolName}`,
      metadata: { input },
    });
  } catch (error) {
    console.warn("Failed to write MCP analytics event:", error instanceof Error ? error.message : error);
  }
}

export async function searchPublicListings(input: {
  locality?: string;
  city?: string;
  property_type?: "sale" | "rent" | "lease" | "all";
  bhk?: number;
  max_budget_cr?: number;
  budget_min_cr?: number;
  budget_max_cr?: number;
  listingKind?: "listing" | "requirement";
  limit?: number;
}) {
  const limit = clampLimit(input.limit);
  const rows = await fetchParsedMarketRows(Math.max(limit * 20, 500));
  return normalizePublicListings(filterPublicListingRows(rows, input)).slice(0, limit);
}

export async function getFreshStream(input: { hours?: number; city?: string; limit?: number }) {
  const hours = Math.min(Math.max(input.hours ?? 72, 1), 168);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const limit = clampLimit(input.limit, 50, 100);
  const rows = await fetchParsedMarketRows(Math.max(limit * 10, 250), since);
  return normalizePublicListings(filterPublicListingRows(rows, { city: input.city })).slice(0, limit);
}

export async function getWorkspaceListings(input: {
  brokerId: string;
  limit?: number;
}) {
  const { data, error } = await supabase
    .from("listings")
    .select("id, intent, bhk, price, price_unit, area_sqft, furnishing, location_label, micro_market, building_name, broker_name, broker_phone, created_at, last_seen")
    .eq("tenant_id", input.brokerId)
    .order("last_seen", { ascending: false, nullsFirst: false })
    .limit(clampLimit(input.limit, 25, 100));

  if (error) throw new Error(error.message);
  return (data || []).map((row: any) => ({
    id: String(row.id),
    structured_data: {
      title: row.building_name || row.location_label || "Saved listing",
      bhk: row.bhk,
      location: row.micro_market || row.location_label,
      price: row.price != null ? `${row.price} ${row.price_unit || "cr"}` : null,
      carpet_area: row.area_sqft,
      furnishing: row.furnishing,
      contact_number: row.broker_phone,
    },
    raw_text: [
      row.bhk,
      row.building_name,
      row.micro_market || row.location_label,
      row.price != null ? `${row.price} ${row.price_unit || "cr"}` : null,
    ].filter(Boolean).join(" "),
    created_at: row.last_seen || row.created_at,
  })) as Array<{
    id: string;
    structured_data: Record<string, unknown> | null;
    raw_text: string | null;
    created_at: string | null;
  }>;
}

export function describeSearch(input: {
  locality?: string;
  city?: string;
  bhk?: number;
  max_budget_cr?: number;
  budget_min_cr?: number;
  budget_max_cr?: number;
}) {
  const place = [input.locality, input.city].filter(Boolean).join(", ") || "all areas";
  const bhk = input.bhk ? `${input.bhk}BHK ` : "";
  const budget = formatBudgetRange(input.budget_min_cr, input.max_budget_cr ?? input.budget_max_cr);
  return `${bhk}${place}, ${budget}`;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

type LeadRecordInput = {
  brokerId: string;
  name: string;
  phone?: string;
  recordType: "inventory_listing" | "buyer_requirement";
  rawText: string;
  source?: string;
  payload?: Record<string, unknown>;
  budget?: number | null;
  locationHint?: string | null;
  city?: string | null;
  locality?: string | null;
  urgency?: "high" | "medium" | "low" | null;
  priorityBucket?: "P1" | "P2" | "P3" | null;
  priorityScore?: number | null;
};

function normalizePhone(value?: string | null) {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return value?.trim() || "";
}

function compactText(value?: string | null) {
  return String(value || "").trim();
}

function mcpFingerprint(prefix: string, brokerId: string, text: string) {
  return crypto
    .createHash("sha1")
    .update([prefix, brokerId, normalizeListingText(text)].join("|"))
    .digest("hex");
}

function splitDueDateTime(value?: string | null) {
  const parsed = value ? new Date(value) : new Date(Date.now() + 24 * 60 * 60 * 1000);
  const safeDate = Number.isNaN(parsed.getTime()) ? new Date(Date.now() + 24 * 60 * 60 * 1000) : parsed;
  return {
    due_date: safeDate.toISOString().slice(0, 10),
    due_time: safeDate.toISOString().slice(11, 19),
    due_at: safeDate.toISOString(),
  };
}

function fallbackLeadId(input: { recordType: string; phone?: string; locality?: string | null; rawText: string }) {
  const hash = crypto.createHash("sha256").update(input.rawText).digest("hex").slice(0, 12);
  return [input.recordType, input.phone || "unknown", input.locality || "na", hash].join(":");
}

function parseBudgetToCr(value?: string | number | null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*(cr|crore|crores|lakh|lakhs|lac|lacs|k|thousand)?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] || "cr").toLowerCase();
  if (["cr", "crore", "crores"].includes(unit)) return amount;
  if (["lakh", "lakhs", "lac", "lacs"].includes(unit)) return amount / 100;
  if (["k", "thousand"].includes(unit)) return amount / 10000;
  return amount;
}

function inferUrgency(text: string): "high" | "medium" | "low" {
  if (/\b(urgent|immediate|today|asap|closing|hot)\b/i.test(text)) return "high";
  if (/\b(this week|soon|priority|follow up)\b/i.test(text)) return "medium";
  return "low";
}

function inferPriorityBucket(urgency: "high" | "medium" | "low"): "P1" | "P2" | "P3" {
  if (urgency === "high") return "P1";
  if (urgency === "medium") return "P2";
  return "P3";
}

function scoreFromUrgency(urgency: "high" | "medium" | "low") {
  if (urgency === "high") return 85;
  if (urgency === "medium") return 68;
  return 52;
}

async function upsertLeadRecord(input: LeadRecordInput) {
  const now = new Date().toISOString();
  const phone = normalizePhone(input.phone);
  const urgency = input.urgency || inferUrgency(input.rawText);
  const priorityBucket = input.priorityBucket || inferPriorityBucket(urgency);
  const priorityScore = input.priorityScore ?? scoreFromUrgency(urgency);
  const locality = input.locality || input.locationHint || null;

  let clientId: number | null = null;
  if (phone) {
    const { data: existingClient, error: existingError } = await supabase
      .from("clients")
      .select("id")
      .eq("tenant_id", input.brokerId)
      .eq("phone", phone)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingError) throw new Error(existingError.message);
    clientId = existingClient?.id ?? null;
  }

  if (clientId == null) {
    const { data: clientRow, error: clientError } = await supabase
      .from("clients")
      .insert({
        tenant_id: input.brokerId,
        name: compactText(input.name) || "MCP Lead",
        phone: phone || null,
        notes: input.rawText,
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();
    if (clientError) throw new Error(clientError.message);
    clientId = clientRow.id;
  }

  let requirementId: number | null = null;
  if (input.recordType === "buyer_requirement") {
    const { data: requirementRow, error: requirementError } = await supabase
      .from("client_requirements")
      .insert({
        tenant_id: input.brokerId,
        client_id: clientId,
        intent: "requirement",
        bhk: Array.isArray(input.payload?.bhk_preference)
          ? (input.payload?.bhk_preference as unknown[]).join(", ")
          : null,
        price_max: input.budget ?? null,
        micro_market: locality,
        notes: input.rawText,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();
    if (requirementError) throw new Error(requirementError.message);
    requirementId = requirementRow.id;
  }

  return {
    lead_id: requirementId ? String(requirementId) : String(clientId),
    client_id: clientId,
    requirement_id: requirementId,
    phone: phone || null,
    priority_bucket: priorityBucket,
    urgency,
    priority_score: priorityScore,
  };
}

export async function saveListingRecord(input: {
  brokerId: string;
  name?: string;
  phone?: string;
  raw_text: string;
  bhk?: string;
  location?: string;
  price?: string;
  carpet_area?: string;
  furnishing?: string;
  possession_date?: string;
  contact_number?: string;
}) {
  const structured = {
    bhk: input.bhk || null,
    location: input.location || null,
    price: input.price || null,
    carpet_area: input.carpet_area || null,
    furnishing: input.furnishing || null,
    possession_date: input.possession_date || null,
    contact_number: normalizePhone(input.contact_number || input.phone) || null,
    source: "mcp",
  };

  const { data, error } = await supabase
    .from("listings")
    .upsert({
      tenant_id: input.brokerId,
      fingerprint: mcpFingerprint("mcp-listing", input.brokerId, input.raw_text),
      intent: "listing",
      bhk: input.bhk || null,
      price: parseBudgetToCr(input.price),
      price_unit: input.price ? "cr" : null,
      area_sqft: toNumber(input.carpet_area),
      furnishing: input.furnishing || null,
      location_label: input.location || null,
      micro_market: input.location || null,
      broker_name: input.name || null,
      broker_phone: normalizePhone(input.contact_number || input.phone) || null,
      listing_source: "mcp",
      last_seen: new Date().toISOString(),
    }, { onConflict: "fingerprint" })
    .select("id, created_at")
    .single();

  if (error) throw new Error(error.message);

  const lead = await upsertLeadRecord({
    brokerId: input.brokerId,
    name: input.name || "MCP Listing",
    phone: input.phone || input.contact_number,
    recordType: "inventory_listing",
    rawText: input.raw_text,
    source: "mcp",
    locationHint: input.location || null,
    locality: input.location || null,
    budget: parseBudgetToCr(input.price),
    payload: structured,
  });

  return {
    listing_id: data?.id || null,
    created_at: data?.created_at || null,
    lead,
    listing: structured,
  };
}

export async function createRequirementRecord(input: {
  brokerId: string;
  name?: string;
  phone?: string;
  raw_text: string;
  budget?: string | number;
  location_pref?: string;
  timeline?: string;
  possession?: string;
  bhk_preference?: string[];
  property_type?: string;
  listing_type?: string;
}) {
  const budgetCr = parseBudgetToCr(input.budget);
  const payload = {
    budget: budgetCr,
    location_pref: input.location_pref || null,
    timeline: input.timeline || null,
    possession: input.possession || null,
    bhk_preference: input.bhk_preference || [],
    property_type: input.property_type || null,
    listing_type: input.listing_type || null,
  };

  const lead = await upsertLeadRecord({
    brokerId: input.brokerId,
    name: input.name || "MCP Requirement",
    phone: input.phone,
    recordType: "buyer_requirement",
    rawText: input.raw_text,
    source: "mcp",
    budget: budgetCr,
    locationHint: input.location_pref || null,
    locality: input.location_pref || null,
    payload,
  });

  return {
    requirement: payload,
    lead,
  };
}

export async function scheduleFollowUp(input: {
  brokerId: string;
  lead_id?: string;
  lead_name: string;
  lead_phone?: string;
  due_at?: string;
  notes?: string;
  action_type?: "call" | "email" | "visit";
  priority_bucket?: "P1" | "P2" | "P3";
}) {
  const due = splitDueDateTime(input.due_at);
  const { error } = await supabase
    .from("follow_ups")
    .insert({
      tenant_id: input.brokerId,
      client_id: input.lead_id && /^\d+$/.test(input.lead_id) ? Number(input.lead_id) : null,
      broker_phone: normalizePhone(input.lead_phone) || null,
      follow_up_type: input.action_type || "call",
      title: input.lead_name,
      due_date: due.due_date,
      due_time: due.due_time,
      status: "pending",
      notes: input.notes || null,
      created_at: new Date().toISOString(),
    });

  if (error) throw new Error(error.message);

  return {
    scheduled: true,
    due_at: due.due_at,
    action_type: input.action_type || "call",
  };
}

export async function getBrokerActivity(input: { brokerId: string; days?: number }) {
  const days = Math.min(Math.max(input.days ?? 7, 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [listingResult, requirementResult, messageResult, followUpResult] = await Promise.all([
    supabase
      .from("listings")
      .select("micro_market, location_label, created_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("client_requirements")
      .select("micro_market, created_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("raw_messages")
      .select("sender_jid, group_name, message, sender, timestamp, created_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("follow_ups")
      .select("title, due_date, due_time, status, broker_phone")
      .eq("tenant_id", input.brokerId)
      .eq("status", "pending")
      .order("due_date", { ascending: true })
      .limit(25),
  ]);

  if (listingResult.error) throw new Error(listingResult.error.message);
  if (requirementResult.error) throw new Error(requirementResult.error.message);
  if (messageResult.error) throw new Error(messageResult.error.message);
  if (followUpResult.error) throw new Error(followUpResult.error.message);

  const listings = listingResult.data || [];
  const requirements = requirementResult.data || [];
  const messages = messageResult.data || [];
  const followUps = followUpResult.data || [];
  const localities = new Map<string, number>();

  for (const row of [...listings, ...requirements]) {
    const locality = String((row as any).micro_market || (row as any).location_label || "").trim();
    if (!locality) continue;
    localities.set(locality, (localities.get(locality) || 0) + 1);
  }

  return {
    days,
    leads_total: listings.length + requirements.length,
    listings_total: listings.length,
    requirements_total: requirements.length,
    p1_total: 0,
    messages_total: messages.length,
    active_chats: new Set(messages.map((row) => row.sender_jid || row.group_name).filter(Boolean)).size,
    pending_follow_ups: followUps.length,
    next_follow_up: followUps[0]
      ? {
          lead_name: followUps[0].title,
          due_at: [followUps[0].due_date, followUps[0].due_time].filter(Boolean).join(" "),
          status: followUps[0].status,
        }
      : null,
    top_localities: [...localities.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([locality, count]) => ({ locality, count })),
  };
}

export async function getHotLeadTriage(input: { brokerId: string; days?: number; limit?: number }) {
  const days = Math.min(Math.max(input.days ?? 7, 1), 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [requirementResult, followUpResult] = await Promise.all([
    supabase
      .from("client_requirements")
      .select("id, client_id, intent, bhk, price_max, micro_market, building_name, notes, created_at, updated_at, clients(name, phone)")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(100),
    supabase
      .from("follow_ups")
      .select("client_id, title, broker_phone, due_date, due_time, status, notes")
      .eq("tenant_id", input.brokerId)
      .eq("status", "pending")
      .order("due_date", { ascending: true })
      .limit(100),
  ]);

  if (requirementResult.error) throw new Error(requirementResult.error.message);
  if (followUpResult.error) throw new Error(followUpResult.error.message);

  const requirements = requirementResult.data || [];
  const followUps = followUpResult.data || [];
  const now = Date.now();
  const followUpByClientId = new Map<number, typeof followUps[number]>();
  const followUpByPhone = new Map<string, typeof followUps[number]>();

  for (const item of followUps) {
    if (item.client_id) followUpByClientId.set(Number(item.client_id), item);
    if (item.broker_phone) followUpByPhone.set(item.broker_phone, item);
  }

  const scored = requirements.map((lead: any) => {
    const client = Array.isArray(lead.clients) ? lead.clients[0] : lead.clients;
    const phone = client?.phone || null;
    const followUp = (lead.client_id && followUpByClientId.get(Number(lead.client_id)))
      || (phone && followUpByPhone.get(phone))
      || null;
    const leadText = String(lead.notes || "").toLowerCase();

    let score = 0;

    if (/\b(site visit|visit|inspection|closing|token|final|urgent|asap|immediate)\b/i.test(leadText)) {
      score += 10;
    }

    if (followUp?.due_date) {
      const dueAt = new Date(`${followUp.due_date}T${followUp.due_time || "00:00:00"}`).getTime();
      if (!Number.isNaN(dueAt)) {
        if (dueAt <= now) score += 18;
        else if (dueAt - now <= 24 * 60 * 60 * 1000) score += 10;
      }
    } else {
      score += 6;
    }

    if (lead.micro_market) score += 6;
    if (lead.price_max != null) score += 4;

    const why = [
      followUp?.due_date
        ? new Date(`${followUp.due_date}T${followUp.due_time || "00:00:00"}`).getTime() <= now
          ? "follow-up overdue"
          : "follow-up scheduled"
        : "no follow-up booked",
      lead.micro_market ? "locality known" : null,
      lead.price_max != null ? "budget known" : null,
    ].filter(Boolean) as string[];

    return {
      lead_id: String(lead.id),
      name: client?.name || followUp?.title || "Unknown lead",
      phone,
      record_type: "buyer_requirement",
      location: lead.micro_market || lead.building_name || null,
      budget: lead.price_max ?? null,
      priority_bucket: null,
      urgency: null,
      due_at: followUp?.due_date ? [followUp.due_date, followUp.due_time].filter(Boolean).join(" ") : null,
      score,
      why,
      next_action: followUp?.due_date
        ? "Call or message this lead before the due follow-up slips further."
        : "Book a follow-up now and confirm exact budget, locality, and timeline.",
      raw_text: lead.notes || null,
    };
  });

  const items = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, clampLimit(input.limit, 10, 25));

  return {
    days,
    total_candidates: requirements.length,
    pending_follow_ups: followUps.length,
    items,
  };
}

function tokenizeMatchText(value: string) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3);
}

export async function matchBuyerToInventory(input: {
  brokerId: string;
  raw_text?: string;
  locality?: string;
  city?: string;
  bhk?: number;
  max_budget_cr?: number;
  property_type?: "sale" | "rent" | "lease" | "all";
  source_mode?: "public" | "workspace" | "both";
  limit?: number;
}) {
  const sourceMode = input.source_mode || "both";
  const limit = clampLimit(input.limit, 8, 20);
  const queryTokens = tokenizeMatchText([
    input.raw_text || "",
    input.locality || "",
    input.city || "",
    input.bhk ? `${input.bhk} bhk` : "",
  ].join(" "));

  const [publicRows, workspaceRows] = await Promise.all([
    sourceMode === "workspace"
      ? Promise.resolve([])
      : searchPublicListings({
          locality: input.locality,
          city: input.city,
          property_type: input.property_type,
          bhk: input.bhk,
          max_budget_cr: input.max_budget_cr,
          listingKind: "listing",
          limit: 30,
        }),
    sourceMode === "public"
      ? Promise.resolve([])
      : getWorkspaceListings({ brokerId: input.brokerId, limit: 30 }),
  ]);

  const publicMatches = publicRows.map((row) => {
    let score = 0;
    const why: string[] = [];
    const localityText = `${row.sub_area || ""} ${row.area || ""} ${row.location || ""}`.toLowerCase();
    if (input.locality && localityText.includes(input.locality.toLowerCase())) {
      score += 28;
      why.push("locality fit");
    }
    if (input.city && localityText.includes(input.city.toLowerCase())) {
      score += 10;
      why.push("city fit");
    }
    if (input.bhk != null && row.bhk === input.bhk) {
      score += 20;
      why.push("BHK fit");
    }
    if (input.max_budget_cr != null && row.price != null) {
      if (row.price <= input.max_budget_cr) {
        score += 22;
        why.push("within budget");
      } else if (row.price <= input.max_budget_cr * 1.12) {
        score += 8;
        why.push("slightly above budget");
      }
    }
    const haystack = `${row.title || ""} ${row.description || ""} ${row.cleaned_message || ""} ${row.raw_message || ""}`.toLowerCase();
    const tokenHits = queryTokens.filter((token) => haystack.includes(token)).length;
    if (tokenHits > 0) {
      score += Math.min(tokenHits * 4, 16);
      why.push(`${tokenHits} keyword hit${tokenHits > 1 ? "s" : ""}`);
    }
    if (row.message_timestamp) {
      const ageHours = Math.max(0, (Date.now() - new Date(row.message_timestamp).getTime()) / 3600000);
      if (ageHours <= 24) {
        score += 10;
        why.push("fresh listing");
      } else if (ageHours <= 72) {
        score += 5;
      }
    }
    return {
      source: "public" as const,
      source_id: row.source_message_id,
      title: row.title || listingLabel(row),
      location: row.sub_area || row.area || row.location || null,
      price: row.price,
      bhk: row.bhk,
      size_sqft: row.size_sqft,
      contact: row.primary_contact_wa || row.primary_contact_number || null,
      created_at: row.message_timestamp || row.created_at,
      score,
      why,
      raw_text: row.raw_message || row.cleaned_message || row.description || null,
    };
  });

  const workspaceMatches = workspaceRows.map((row) => {
    const structured = row.structured_data || {};
    const location = String(structured.location || structured.locality || "").trim() || null;
    const bhkText = String(structured.bhk || "").trim();
    const priceText = String(structured.price || "").trim();
    const priceCr = parseBudgetToCr(priceText);
    let score = 0;
    const why: string[] = [];

    if (input.locality && location?.toLowerCase().includes(input.locality.toLowerCase())) {
      score += 28;
      why.push("locality fit");
    }
    if (input.bhk != null && bhkText && bhkText.toLowerCase().includes(String(input.bhk))) {
      score += 20;
      why.push("BHK fit");
    }
    if (input.max_budget_cr != null && priceCr != null) {
      if (priceCr <= input.max_budget_cr) {
        score += 22;
        why.push("within budget");
      } else if (priceCr <= input.max_budget_cr * 1.12) {
        score += 8;
        why.push("slightly above budget");
      }
    }

    const haystack = `${row.raw_text || ""} ${JSON.stringify(structured)}`.toLowerCase();
    const tokenHits = queryTokens.filter((token) => haystack.includes(token)).length;
    if (tokenHits > 0) {
      score += Math.min(tokenHits * 4, 16);
      why.push(`${tokenHits} keyword hit${tokenHits > 1 ? "s" : ""}`);
    }

    if (row.created_at) {
      const ageHours = Math.max(0, (Date.now() - new Date(row.created_at).getTime()) / 3600000);
      if (ageHours <= 24) {
        score += 8;
        why.push("fresh CRM listing");
      } else if (ageHours <= 72) {
        score += 4;
      }
    }

    return {
      source: "workspace" as const,
      source_id: row.id,
      title: String(structured.title || structured.location || "Saved listing"),
      location,
      price: priceCr,
      bhk: bhkText ? Number.parseInt(bhkText, 10) || null : null,
      size_sqft: toNumber(structured.carpet_area || structured.size_sqft),
      contact: String(structured.contact_number || "").trim() || null,
      created_at: row.created_at,
      score,
      why,
      raw_text: row.raw_text,
    };
  });

  const items = [...publicMatches, ...workspaceMatches]
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({
      ...item,
      suggested_action: item.contact
        ? "Send this buyer the listing summary and confirm viewing interest."
        : "Review the listing details and confirm the best contact path before sharing.",
      weak_points: [
        item.price == null ? "price unclear" : null,
        item.location == null ? "location unclear" : null,
        item.bhk == null ? "BHK unclear" : null,
      ].filter(Boolean),
    }));

  return {
    source_mode: sourceMode,
    total_considered: publicMatches.length + workspaceMatches.length,
    items,
  };
}

export async function getPendingFollowUps(input: { brokerId: string; limit?: number }) {
  const { data, error } = await supabase
    .from("follow_ups")
    .select("id, client_id, title, broker_phone, follow_up_type, due_date, due_time, status, notes, created_at")
    .eq("tenant_id", input.brokerId)
    .eq("status", "pending")
    .order("due_date", { ascending: true })
    .limit(clampLimit(input.limit, 25, 100));

  if (error) throw new Error(error.message);
  return (data || []).map((row: any) => ({
    lead_id: row.client_id ? String(row.client_id) : String(row.id),
    lead_name: row.title,
    lead_phone: row.broker_phone,
    action_type: row.follow_up_type,
    due_at: [row.due_date, row.due_time].filter(Boolean).join(" "),
    status: row.status,
    notes: row.notes,
    priority_bucket: null,
    created_at: row.created_at,
  }));
}

export async function getRecentSavedListings(input: { brokerId: string; limit?: number }) {
  return getWorkspaceListings(input);
}

export async function getRecentRequirements(input: { brokerId: string; limit?: number }) {
  const { data, error } = await supabase
    .from("client_requirements")
    .select("id, client_id, micro_market, building_name, price_max, notes, created_at, clients(name, phone)")
    .eq("tenant_id", input.brokerId)
    .order("created_at", { ascending: false })
    .limit(clampLimit(input.limit, 20, 100));

  if (error) throw new Error(error.message);
  return (data || []).map((row: any) => {
    const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
    return {
      lead_id: String(row.id),
      name: client?.name || "Unknown lead",
      phone: client?.phone || null,
      location_hint: row.micro_market || row.building_name || null,
      locality_canonical: row.micro_market || null,
      budget: row.price_max ?? null,
      raw_text: row.notes || null,
      created_at: row.created_at,
    };
  });
}

export async function getStoredThreadMessages(input: {
  brokerId: string;
  remoteJid?: string;
  limit?: number;
}) {
  let query = supabase
    .from("raw_messages")
    .select("sender_jid, group_name, message, sender, timestamp, created_at")
    .eq("tenant_id", input.brokerId)
    .order("timestamp", { ascending: false, nullsFirst: false })
    .limit(clampLimit(input.limit, 40, 200));

  if (input.remoteJid) {
    query = query.or(`sender_jid.eq.${input.remoteJid},group_name.eq.${input.remoteJid}`);
  } else {
    query = query.not("message", "is", null);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []).map((row: any) => ({
    remote_jid: row.sender_jid || row.group_name || "",
    text: row.message || null,
    sender: row.sender || null,
    timestamp: row.timestamp || null,
    created_at: row.created_at || null,
  })) as Array<{
    remote_jid: string;
    text: string | null;
    sender: string | null;
    timestamp: string | null;
    created_at: string | null;
  }>;
}

export async function getMarketSummary(input: {
  locality?: string;
  city?: string;
  property_type?: "sale" | "rent" | "lease" | "all";
  bhk?: number;
  days?: number;
  limit?: number;
}) {
  const days = Math.min(Math.max(input.days ?? 30, 1), 180);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const limit = clampLimit(input.limit, 200, 500);
  const parsedRows = await fetchParsedMarketRows(limit, since);
  const rows = normalizePublicListings(filterPublicListingRows(parsedRows, input));

  // Separate sale/lease prices from rent prices. Blending them into one
  // average is meaningless (crores vs thousands-per-month), so compute them
  // independently. `row.price` is in absolute rupees (see normalizeParsedPrice).
  const SALE_MIN = 100_000;            // 1 lakh
  const SALE_MAX = 500_000_000;       // 500 crore
  const RENT_MIN = 5_000;             // 5k / month
  const RENT_MAX = 50_000_000;       // 50 lakh / month

  const salePrices: number[] = [];
  const rentPrices: number[] = [];
  for (const row of rows) {
    if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price <= 0) continue;
    const dealType = inferPublicDealType(row);
    if (dealType === "rent") {
      if (row.price >= RENT_MIN && row.price <= RENT_MAX) rentPrices.push(row.price);
    } else if (dealType === "sale" || dealType === "lease") {
      if (row.price >= SALE_MIN && row.price <= SALE_MAX) salePrices.push(row.price);
    }
  }

  const ppsf = rows
    .map((row) => row.price != null && row.size_sqft ? row.price / row.size_sqft : null)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const localityCounts = new Map<string, number>();
  for (const row of rows) {
    const locality = String(row.sub_area || row.area || row.location || "").trim();
    if (!locality) continue;
    localityCounts.set(locality, (localityCounts.get(locality) || 0) + 1);
  }

  const avgSaleRupees = salePrices.length
    ? salePrices.reduce((sum, value) => sum + value, 0) / salePrices.length
    : null;
  const avgRentRupees = rentPrices.length
    ? rentPrices.reduce((sum, value) => sum + value, 0) / rentPrices.length
    : null;

  return {
    days,
    listing_count: rows.length,
    // avg_price_cr holds the average SALE price in absolute rupees
    // (consumers format it via formatCurrencyCr, which converts to Cr/Lakh).
    avg_price_cr: avgSaleRupees != null ? Number(avgSaleRupees.toFixed(2)) : null,
    median_price_cr: salePrices.length ? median(salePrices) : null,
    avg_rent_per_month: avgRentRupees != null ? Math.round(avgRentRupees) : null,
    avg_price_per_sqft: ppsf.length ? Math.round(ppsf.reduce((sum, value) => sum + value, 0) / ppsf.length) : null,
    freshest_message_at: rows[0]?.message_timestamp || rows[0]?.created_at || null,
    top_localities: [...localityCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([locality, count]) => ({ locality, count })),
    sample: rows.slice(0, 5),
  };
}

export async function estimatePrice(input: {
  locality?: string;
  building_name?: string;
  bhk?: number;
  area_sqft?: number;
  property_type?: "sale" | "rent" | "lease" | "all";
}) {
  const market = await getMarketSummary({
    locality: input.locality,
    property_type: input.property_type || "sale",
    bhk: input.bhk,
    days: 90,
    limit: 250,
  });
  const publicPpsf = market.avg_price_per_sqft;
  const referencePpsf = publicPpsf || null;
  const estimatedPriceCr = referencePpsf && input.area_sqft
    ? Math.round(referencePpsf * input.area_sqft)
    : market.median_price_cr;

  return {
    estimated_price_cr: estimatedPriceCr,
    reference_price_per_sqft: referencePpsf,
    public_market: market,
    summary: referencePpsf
      ? input.area_sqft
        ? `Estimated value: ${formatCurrencyCr(estimatedPriceCr)} using ${formatPerSqft(referencePpsf)} and ${Math.round(input.area_sqft).toLocaleString("en-IN")} sqft.`
        : `Reference market rate: ${formatPerSqft(referencePpsf)}. Add area_sqft for a tighter estimate.`
      : "Not enough comparable data to estimate a price yet.",
  };
}

export async function buildPricingNegotiationBrief(input: {
  locality?: string;
  building_name?: string;
  bhk?: number;
  area_sqft?: number;
  asking_price_cr?: number;
  property_type?: "sale" | "rent" | "lease" | "all";
}) {
  const estimate = await estimatePrice({
    locality: input.locality,
    building_name: input.building_name,
    bhk: input.bhk,
    area_sqft: input.area_sqft,
    property_type: input.property_type || "sale",
  });

  const askingPrice = input.asking_price_cr ?? null;
  const estimatedPrice = estimate.estimated_price_cr ?? null;
  const referencePpsf = estimate.reference_price_per_sqft ?? null;
  const publicRate = estimate.public_market?.avg_price_per_sqft ?? null;

  let pricePosition: "above_market" | "at_market" | "below_market" | "unknown" = "unknown";
  let deltaCr: number | null = null;
  if (askingPrice != null && estimatedPrice != null) {
    deltaCr = Number((askingPrice - estimatedPrice).toFixed(2));
    const ratio = estimatedPrice > 0 ? askingPrice / estimatedPrice : null;
    if (ratio != null) {
      if (ratio >= 1.08) pricePosition = "above_market";
      else if (ratio <= 0.94) pricePosition = "below_market";
      else pricePosition = "at_market";
    }
  }

  const negotiationStance = (() => {
    if (pricePosition === "above_market") {
      return "Push back with comparables and anchor the conversation around realistic clearing price rather than the first ask.";
    }
    if (pricePosition === "below_market") {
      return "Move fast. This looks competitive relative to current comps, so confirm condition, availability, and seller seriousness before others do.";
    }
    if (pricePosition === "at_market") {
      return "Negotiate on terms, urgency, furnishing, and payment certainty rather than forcing a large price cut.";
    }
    return "Use current PropAI market comparables to test the ask before taking a hard negotiation stance.";
  })();

  const leveragePoints = [
    publicRate != null ? `Public comparable rate around ${formatPerSqft(publicRate)}` : null,
    askingPrice != null && estimatedPrice != null
      ? `Ask is ${deltaCr && deltaCr > 0 ? `${formatCurrencyCr(deltaCr)} above` : deltaCr && deltaCr < 0 ? `${formatCurrencyCr(Math.abs(deltaCr))} below` : "roughly at"} the estimated market value`
      : null,
  ].filter(Boolean) as string[];

  const risks = [
    askingPrice == null ? "Asking price not provided, so the brief is based on market reference only." : null,
    referencePpsf == null ? "Comparable market rate is thin, so pricing confidence is lower than normal." : null,
    input.area_sqft == null ? "Area not provided, so valuation falls back to broader market comps." : null,
  ].filter(Boolean) as string[];

  const summaryParts = [
    estimatedPrice != null ? `Estimated value: ${formatCurrencyCr(estimatedPrice)}.` : "Estimated value unavailable.",
    askingPrice != null ? `Current ask: ${formatCurrencyCr(askingPrice)}.` : "Current ask not provided.",
    pricePosition === "above_market"
      ? "This ask looks above market."
      : pricePosition === "below_market"
        ? "This ask looks competitive to slightly below market."
        : pricePosition === "at_market"
          ? "This ask looks close to market."
          : "Market position is still uncertain.",
  ];

  return {
    asking_price_cr: askingPrice,
    estimated_price_cr: estimatedPrice,
    price_position: pricePosition,
    delta_cr: deltaCr,
    reference_price_per_sqft: referencePpsf,
    public_market: estimate.public_market,
    leverage_points: leveragePoints,
    risks,
    negotiation_stance: negotiationStance,
    summary: summaryParts.join(" "),
  };
}

export async function getStaleLeadReactivation(input: {
  brokerId: string;
  days_stale?: number;
  limit?: number;
}) {
  const staleDays = Math.min(Math.max(input.days_stale ?? 21, 7), 180);
  const cutoffIso = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString();

  const [leadResult, followUpResult] = await Promise.all([
    supabase
      .from("client_requirements")
      .select("id, client_id, micro_market, building_name, price_max, notes, created_at, updated_at, clients(name, phone)")
      .eq("tenant_id", input.brokerId)
      .lt("updated_at", cutoffIso)
      .order("updated_at", { ascending: true, nullsFirst: false })
      .limit(100),
    supabase
      .from("follow_ups")
      .select("client_id, title, broker_phone, due_date, due_time, status, notes")
      .eq("tenant_id", input.brokerId)
      .order("due_date", { ascending: false })
      .limit(200),
  ]);

  if (leadResult.error) throw new Error(leadResult.error.message);
  if (followUpResult.error) throw new Error(followUpResult.error.message);

  const followUps = followUpResult.data || [];
  const followUpByClientId = new Map<number, typeof followUps[number]>();
  const followUpByPhone = new Map<string, typeof followUps[number]>();

  for (const item of followUps) {
    if (item.client_id) followUpByClientId.set(Number(item.client_id), item);
    if (item.broker_phone) followUpByPhone.set(item.broker_phone, item);
  }

  const items = (leadResult.data || [])
    .map((lead: any) => {
      const client = Array.isArray(lead.clients) ? lead.clients[0] : lead.clients;
      const phone = client?.phone || null;
      const followUp = (lead.client_id && followUpByClientId.get(Number(lead.client_id)))
        || (phone && followUpByPhone.get(phone))
        || null;
      const lastTouchedAt = lead.updated_at || lead.created_at;
      const staleForDays = lastTouchedAt
        ? Math.max(1, Math.floor((Date.now() - new Date(lastTouchedAt).getTime()) / (24 * 60 * 60 * 1000)))
        : staleDays;

      let score = staleForDays;

      score += 8;
      if (!followUp || followUp.status !== "pending") score += 6;

      const why = [
        `${staleForDays} days stale`,
        "buyer-side requirement",
        !followUp || followUp.status !== "pending" ? "no active follow-up" : "follow-up exists",
      ].filter(Boolean) as string[];

      const location = lead.micro_market || lead.building_name || null;
      const budgetText = lead.price_max != null ? formatCurrencyCr(lead.price_max) : null;
      const rawText = String(lead.notes || "").trim();
      const name = client?.name || "there";
      const opener = `Hi ${name}, circling back on your ${location || "property"} requirement. Still active, or has the brief changed?`;

      return {
        lead_id: String(lead.id),
        name: client?.name || "Unknown lead",
        phone,
        record_type: "buyer_requirement",
        location,
        budget: budgetText,
        stale_for_days: staleForDays,
        score,
        why,
        recommended_channel: phone ? "whatsapp_or_call" : "manual_review",
        reactivation_opener: opener,
        next_action: phone
          ? "Send the opener, then confirm current need, timing, and whether pricing has moved."
          : "Find the latest contact path before attempting reactivation.",
        raw_text: rawText || null,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, clampLimit(input.limit, 10, 25));

  return {
    days_stale: staleDays,
    total_candidates: (leadResult.data || []).length,
    items,
  };
}

export async function qualifyLead(input: {
  brokerId: string;
  lead_id?: string;
  name?: string;
  phone?: string;
  raw_text: string;
  budget?: string | number;
  location_pref?: string;
  timeline?: string;
  possession?: string;
}) {
  const phone = normalizePhone(input.phone);
  const budgetCr = parseBudgetToCr(input.budget);
  const urgency = inferUrgency([input.raw_text, input.timeline, input.possession].filter(Boolean).join(" "));
  const priorityBucket = inferPriorityBucket(urgency);
  const priorityScore = scoreFromUrgency(urgency);

  let existingLeadId = input.lead_id || null;
  if (!existingLeadId && phone) {
    const { data } = await supabase
      .from("clients")
      .select("id")
      .eq("tenant_id", input.brokerId)
      .eq("phone", phone)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    existingLeadId = data?.id ? String(data.id) : null;
  }

  const payload = {
    qualification: {
      budget: budgetCr,
      location_pref: input.location_pref || null,
      timeline: input.timeline || null,
      possession: input.possession || null,
      qualified_at: new Date().toISOString(),
      qualified_via: "mcp",
    },
  };

  const lead = await upsertLeadRecord({
    brokerId: input.brokerId,
    name: input.name || "Qualified lead",
    phone,
    recordType: "buyer_requirement",
    rawText: input.raw_text,
    source: "mcp",
    budget: budgetCr,
    locationHint: input.location_pref || null,
    locality: input.location_pref || null,
    urgency,
    priorityBucket,
    priorityScore,
    payload: existingLeadId ? { ...payload, lead_id: existingLeadId } : payload,
  });

  return {
    lead_id: existingLeadId || lead.lead_id,
    qualification: payload.qualification,
    urgency,
    priority_bucket: priorityBucket,
    priority_score: priorityScore,
  };
}

export async function summarizeThread(input: {
  brokerId: string;
  remote_jid: string;
  limit?: number;
}) {
  const rows = (await getStoredThreadMessages({
    brokerId: input.brokerId,
    remoteJid: input.remote_jid,
    limit: input.limit,
  })).filter((row) => String(row.text || "").trim());
  const ordered = [...rows].reverse();
  const inboundCount = rows.filter((row) => !String(row.sender || "").toLowerCase().includes("ai")).length;
  const outboundCount = rows.length - inboundCount;
  const latest = rows[0] || null;

  return {
    remote_jid: input.remote_jid,
    message_count: rows.length,
    inbound_count: inboundCount,
    outbound_count: outboundCount,
    last_message_at: latest?.timestamp || latest?.created_at || null,
    participants: [...new Set(rows.map((row) => String(row.sender || "").trim()).filter(Boolean))],
    key_points: ordered.slice(-5).map((row) => ({
      sender: row.sender,
      text: String(row.text || "").slice(0, 240),
      timestamp: row.timestamp || row.created_at,
    })),
  };
}

export function buildBroadcastDraft(input: {
  title?: string;
  location?: string;
  bhk?: string;
  price?: string;
  area_sqft?: number;
  furnishing?: string;
  contact_name?: string;
  contact_number?: string;
  notes?: string;
  call_to_action?: string;
}) {
  const lines = [
    input.title || "Fresh listing",
    [input.bhk, input.location].filter(Boolean).join(" in "),
    input.price ? `Price: ${input.price}` : null,
    input.area_sqft ? `Area: ${Math.round(input.area_sqft).toLocaleString("en-IN")} sqft` : null,
    input.furnishing ? `Furnishing: ${input.furnishing}` : null,
    input.notes || null,
    input.contact_name || input.contact_number
      ? `Contact: ${[input.contact_name, normalizePhone(input.contact_number)].filter(Boolean).join(" ")}`
      : null,
    input.call_to_action || "DM for inspection, photos, and deal details.",
  ].filter(Boolean);

  return lines.join("\n");
}

const VALID_BUILDING_CHARS = /[^a-z0-9\s.-]/g;

function normalizeBuildingName(raw: string): string {
  return raw.trim().toLowerCase().replace(VALID_BUILDING_CHARS, "").replace(/\s+/g, " ").trim();
}

const BUILDING_NEGATIVES = new Set(["-", "--", "na", "n/a", "none", "nil", "unknown", "ask", "tbd"]);

function isValidBuildingName(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = normalizeBuildingName(raw);
  return v.length > 1 && !BUILDING_NEGATIVES.has(v);
}

function normalizeLocality(raw: string | null | undefined): string {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, " ").trim();
}

export type BuildingIntelResponse = {
  building_name: string;
  matched_localities: string[];
  price_benchmarks: {
    sale: PriceBenchmark | null;
    rent: PriceBenchmark | null;
  };
  locality_supply: LocalitySupplyRow[];
  configuration_map: ConfigMapRow[];
  sample_days: number;
};

export type PriceBenchmark = {
  avg_price_per_sqft: number | null;
  min_price_per_sqft: number | null;
  max_price_per_sqft: number | null;
  listing_count: number;
  samples: { price: number; area_sqft: number; per_sqft: number }[];
};

export type LocalitySupplyRow = {
  locality: string;
  listings: number;
  requirements: number;
  ratio: string;
};

export type ConfigMapRow = {
  configuration: string;
  count: number;
  percentage_of_locality: number;
};

const STREAM_INTEL_COLUMNS = "source_message_id, building_name, locality, city, price_numeric, area_sqft, type, configuration, furnishing, record_type, created_at";

function computePriceBenchmark(rows: Array<{ price_numeric: number | null; area_sqft: number | null }>): PriceBenchmark {
  const withSqft = rows.filter((r) => r.price_numeric != null && r.area_sqft != null && r.area_sqft > 0) as Array<{
    price_numeric: number;
    area_sqft: number;
  }>;

  if (withSqft.length === 0) {
    return { avg_price_per_sqft: null, min_price_per_sqft: null, max_price_per_sqft: null, listing_count: 0, samples: [] };
  }

  const perSqftValues = withSqft.map((r) => ({ price: r.price_numeric, area_sqft: r.area_sqft, per_sqft: r.price_numeric / r.area_sqft }));
  const values = perSqftValues.map((r) => r.per_sqft).sort((a, b) => a - b);

  return {
    avg_price_per_sqft: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    min_price_per_sqft: Math.round(values[0]),
    max_price_per_sqft: Math.round(values[values.length - 1]),
    listing_count: values.length,
    samples: perSqftValues.slice(0, 5).map((r) => ({
      price: r.price,
      area_sqft: r.area_sqft,
      per_sqft: Math.round(r.per_sqft),
    })),
  };
}

export async function getBuildingIntel(input: {
  building_name: string;
  locality?: string;
  days_back?: number;
}): Promise<BuildingIntelResponse> {
  const normalizedBuilding = normalizeBuildingName(input.building_name);
  const daysBack = Math.min(Math.max(input.days_back ?? 90, 7), 365);
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();

  const buildingTokens = normalizedBuilding.split(/\s+/).filter(Boolean);
  const parsedRows = await fetchParsedMarketRows(500, since);
  const allRows = normalizePublicListings(parsedRows)
    .filter((row) => {
      const building = normalizeBuildingName(row.title || row.description || row.raw_message || "");
      const locality = normalizeLocality(row.location || row.sub_area || row.area);
      const buildingMatch = buildingTokens.every((token) => building.includes(token));
      const localityMatch = input.locality ? locality.includes(normalizeLocality(input.locality)) : true;
      return buildingMatch && localityMatch;
    })
    .map((row) => ({
      source_message_id: row.source_message_id,
      building_name: row.title || input.building_name,
      locality: row.location || row.sub_area || row.area,
      city: "Mumbai",
      price_numeric: row.price,
      area_sqft: row.size_sqft,
      type: row.property_type === "rent" ? "Rent" : "Sale",
      configuration: row.bhk != null ? `${row.bhk} BHK` : null,
      furnishing: row.furnishing,
      record_type: row.listing_type === "requirement" ? "requirement" : "listing",
      created_at: row.created_at || row.message_timestamp,
    }));

  if (allRows.length === 0) {
    return {
      building_name: input.building_name,
      matched_localities: [],
      price_benchmarks: { sale: null, rent: null },
      locality_supply: [],
      configuration_map: [],
      sample_days: daysBack,
    };
  }

  const matchedLocalities = [...new Set(allRows.map((r) => normalizeLocality(r.locality)).filter(Boolean))];

  const listings = allRows.filter((r) => r.record_type === "listing");
  const requirements = allRows.filter((r) => r.record_type === "requirement");

  const saleListings = listings.filter((r) => r.type === "Sale");
  const rentListings = listings.filter((r) => ["Rent", "Lease", "Pre-leased"].includes(r.type));

  const saleBenchmark = computePriceBenchmark(saleListings);
  const rentBenchmark = computePriceBenchmark(rentListings);

  const localityMap = new Map<string, { listings: Set<string>; requirements: Set<string>; types: Record<string, Set<string>> }>();

  for (const row of allRows) {
    const loc = normalizeLocality(row.locality);
    if (!loc) continue;
    if (!localityMap.has(loc)) {
      localityMap.set(loc, { listings: new Set(), requirements: new Set(), types: {} });
    }
    const entry = localityMap.get(loc)!;

    if (row.record_type === "listing") {
      entry.listings.add(row.source_message_id);
      const t = row.type || "unknown";
      if (!entry.types[t]) entry.types[t] = new Set();
      entry.types[t].add(row.source_message_id);
    } else if (row.record_type === "requirement") {
      entry.requirements.add(row.source_message_id);
    }
  }

  const localitySupply: LocalitySupplyRow[] = [];
  for (const [loc, data] of localityMap) {
    const listingCount = data.listings.size;
    const reqCount = data.requirements.size;
    const ratio =
      reqCount === 0
        ? "seller's market"
        : listingCount / reqCount >= 3
          ? "seller's market"
          : listingCount / reqCount >= 1
            ? "balanced"
            : "buyer's market";
    localitySupply.push({ locality: loc, listings: listingCount, requirements: reqCount, ratio });
  }
  localitySupply.sort((a, b) => b.listings - a.listings);

  const configMap = new Map<string, Set<string>>();
  let localityTotalConfigs = 0;

  for (const row of listings) {
    const cfg = String(row.configuration || "").trim().toUpperCase();
    if (!cfg || /^n\/?a$/i.test(cfg) || cfg === "-") continue;
    if (!configMap.has(cfg)) configMap.set(cfg, new Set());
    configMap.get(cfg)!.add(row.source_message_id);
  }

  localityTotalConfigs = [...configMap.values()].reduce((sum, s) => sum + s.size, 0);

  const configurationMap: ConfigMapRow[] = [];
  for (const [cfg, ids] of configMap) {
    configurationMap.push({
      configuration: cfg,
      count: ids.size,
      percentage_of_locality: localityTotalConfigs > 0 ? Math.round((ids.size / localityTotalConfigs) * 100) : 0,
    });
  }
  configurationMap.sort((a, b) => b.count - a.count);

  return {
    building_name: input.building_name,
    matched_localities: matchedLocalities,
    price_benchmarks: { sale: saleBenchmark, rent: rentBenchmark },
    locality_supply: localitySupply,
    configuration_map: configurationMap,
    sample_days: daysBack,
  };
}

export async function fetchListingById(listingId: string) {
  const parts = sourceIdParts(listingId);
  let query = supabase
    .from("parsed_output")
    .select(PARSED_MARKET_COLUMNS);

  if (parts.rawId != null) {
    query = query.eq("raw_message_id", parts.rawId);
    if (parts.index != null) query = query.eq("listing_index", parts.index);
  } else {
    query = query.eq("id", listingId);
  }

  const { data, error } = await query.limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const normalized = normalizePublicListings([mapParsedRowToPublicListing(data as Record<string, unknown>)]);
  return normalized.length ? normalized[0] : null;
}

export async function findBrokers(input: {
  city?: string;
  locality?: string;
  specialization?: string;
  limit?: number;
}) {
  const limit = clampLimit(input.limit, 20, 100);
  let query = supabase
    .from("brokers")
    .select("id, canonical_name, primary_phone, observation_count, listing_count, requirement_count, rental_count, commercial_count, group_count, last_seen_at, broker_phones(phone)");

  const orConditions: string[] = [];
  if (input.locality) {
    orConditions.push(`canonical_name.ilike.%${input.locality}%`);
  }
  if (input.city) {
    orConditions.push(`canonical_name.ilike.%${input.city}%`);
  }
  if (orConditions.length) {
    query = query.or(orConditions.join(","));
  }

  const { data, error } = await query
    .eq("is_hidden", false)
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  return (data || []).map((broker: any) => {
    const phones = Array.isArray(broker.broker_phones) ? broker.broker_phones : [];
    const primaryPhone = broker.primary_phone || phones[0]?.phone || null;
    return {
      id: String(broker.id),
      broker_id: String(broker.id),
      full_name: broker.canonical_name || "Unknown broker",
      broker_name: broker.canonical_name || "Unknown broker",
      phone: primaryPhone,
      city: input.city || "Mumbai",
      locations: input.locality ? [input.locality] : [],
      agency_name: "",
      app_role: "broker",
      observation_count: broker.observation_count,
      listing_count: broker.listing_count,
      requirement_count: broker.requirement_count,
      last_seen_at: broker.last_seen_at,
    };
  });
}
