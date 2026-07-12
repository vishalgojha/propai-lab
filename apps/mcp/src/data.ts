import crypto from "node:crypto";
import { supabase } from "./supabase.ts";
import { formatBudgetRange, formatCurrencyCr, formatPerSqft, igrSummary, listingLabel, toNumber, formatDate, formatSqft } from "./format.ts";
import type { IgrTransaction, LocalityStats, PublicListing } from "./types.js";

export const PUBLIC_LISTING_COLUMNS =
  "source_message_id, source_group_name, listing_type, area, sub_area, location, price, price_type, size_sqft, furnishing, bhk, property_type, title, description, raw_message, cleaned_message, primary_contact_name, primary_contact_number, primary_contact_wa, message_timestamp";
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
  let query = supabase
    .from("public_listings")
    .select(PUBLIC_LISTING_COLUMNS)
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (input.listingKind) {
    if (input.listingKind === "listing") {
      if (input.property_type === "sale" || input.property_type === "rent") {
        query = query.eq("listing_type", DEAL_TYPE_MAP[input.property_type]);
      } else {
        query = query.eq("listing_type", "listing_rent");
      }
    } else {
      query = query.eq("listing_type", "requirement");
    }
  } else {
    query = applyListingType(query, input.property_type);
  }

  query = applyLocality(query, input.locality, input.city);

  if (input.bhk != null) {
    query = query.eq("bhk", input.bhk);
  }

  query = applyBudget(query, input.max_budget_cr ?? input.budget_max_cr);

  if (input.budget_min_cr != null) {
    query = query.gte("price", input.budget_min_cr * 10_000_000);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return normalizePublicListings(data || []);
}

export async function getFreshStream(input: { hours?: number; city?: string; limit?: number }) {
  const hours = Math.min(Math.max(input.hours ?? 72, 1), 168);
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  let query = supabase
    .from("public_listings")
    .select(PUBLIC_LISTING_COLUMNS)
    .gte("message_timestamp", since)
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .limit(clampLimit(input.limit, 50, 100));

  query = applyLocality(query, undefined, input.city);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return normalizePublicListings(data || []).slice(0, clampLimit(input.limit, 50, 100));
}

export async function getWorkspaceListings(input: {
  brokerId: string;
  limit?: number;
}) {
  const { data, error } = await supabase
    .from("listings")
    .select("id, structured_data, raw_text, created_at")
    .eq("tenant_id", input.brokerId)
    .order("created_at", { ascending: false })
    .limit(clampLimit(input.limit, 25, 100));

  if (error) throw new Error(error.message);
  return (data || []) as Array<{
    id: string;
    structured_data: Record<string, unknown> | null;
    raw_text: string | null;
    created_at: string | null;
  }>;
}

export async function getLastTransactionForBuilding(buildingName: string) {
  const name = buildingName.trim();
  if (!name) return null;

  const { data, error } = await supabase
    .from("igr_transactions")
    .select("doc_number, reg_date, building_name, locality, consideration, area_sqft, price_per_sqft, config")
    .ilike("building_name", `%${name}%`)
    .order("reg_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  return {
    ...data,
    consideration: toNumber(data.consideration),
    area_sqft: toNumber(data.area_sqft),
    price_per_sqft: toNumber(data.price_per_sqft),
  } as IgrTransaction;
}

export async function getLocalityStats(locality: string, months = 6): Promise<LocalityStats | null> {
  const name = locality.trim();
  if (!name) return null;

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  const { data, error } = await supabase
    .from("igr_transactions")
    .select("consideration, price_per_sqft, locality")
    .ilike("locality", `%${name}%`)
    .gte("reg_date", cutoffDate.toISOString().slice(0, 10))
    .order("reg_date", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = data || [];
  const priceValues = rows.map((row) => toNumber(row.price_per_sqft)).filter((value): value is number => value != null);
  const considerationValues = rows.map((row) => toNumber(row.consideration)).filter((value): value is number => value != null);

  return {
    locality: name,
    months,
    avg_price_per_sqft: priceValues.length ? Math.round(priceValues.reduce((sum, value) => sum + value, 0) / priceValues.length) : null,
    median_consideration: median(considerationValues),
    min_consideration: considerationValues.length ? Math.min(...considerationValues) : null,
    max_consideration: considerationValues.length ? Math.max(...considerationValues) : null,
    transaction_count: rows.length,
  };
}

export async function getIgrPrice(input: { building_name?: string; locality?: string }) {
  const transaction = input.building_name ? await getLastTransactionForBuilding(input.building_name) : null;
  const statsLocality = transaction?.locality || input.locality || "";
  const stats = statsLocality ? await getLocalityStats(statsLocality, 6) : null;

  return {
    transaction,
    locality_stats: stats,
    summary: igrSummary(transaction, stats, input.building_name, input.locality),
  };
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

  const contactJid = phone ? `${phone}@s.whatsapp.net` : `unknown-mcp-${input.brokerId.slice(0, 8)}`;

  const { data: contactRow, error: contactError } = await supabase
    .from("contacts")
    .upsert({
      tenant_id: input.brokerId,
      remote_jid: contactJid,
      display_name: input.name || null,
      classification: "Client",
      last_interacted_at: now,
    }, { onConflict: "tenant_id,remote_jid" })
    .select("id")
    .single();

  if (contactError) throw new Error(contactError.message);

  const { data: leadRow, error: leadError } = await supabase
    .from("leads")
    .insert({
      tenant_id: input.brokerId,
      contact_id: contactRow.id,
      status: "New",
      created_at: now,
    })
    .select("id")
    .single();

  if (leadError) throw new Error(leadError.message);

  const { error } = await supabase.from("lead_records").insert({
    tenant_id: input.brokerId,
    lead_id: leadRow.id,
    phone: phone || null,
    name: input.name,
    record_type: input.recordType,
    budget: input.budget ?? null,
    location_hint: input.locationHint ?? locality,
    raw_text: input.rawText,
    created_at: now,
    updated_at: now,
  });

  if (error) throw new Error(error.message);

  return {
    lead_id: leadRow.id,
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
    .insert({
      tenant_id: input.brokerId,
      source_group_id: "mcp",
      structured_data: structured,
      raw_text: input.raw_text,
    })
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
  const dueAt = input.due_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from("follow_up_tasks")
    .upsert({
      tenant_id: input.brokerId,
      lead_id: input.lead_id || null,
      lead_name: input.lead_name,
      lead_phone: normalizePhone(input.lead_phone) || null,
      action_type: input.action_type || "call",
      due_at: dueAt,
      status: "pending",
      notes: input.notes || null,
      priority_bucket: input.priority_bucket || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id,lead_id,action_type,due_at" });

  if (error) throw new Error(error.message);

  return {
    scheduled: true,
    due_at: dueAt,
    action_type: input.action_type || "call",
  };
}

export async function getBrokerActivity(input: { brokerId: string; days?: number }) {
  const days = Math.min(Math.max(input.days ?? 7, 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [leadResult, messageResult, followUpResult] = await Promise.all([
    supabase
      .from("lead_records")
      .select("record_type, location_hint, created_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("messages")
      .select("remote_jid, text, sender, timestamp, created_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("follow_up_tasks")
      .select("lead_name, due_at, status, priority_bucket")
      .eq("tenant_id", input.brokerId)
      .eq("status", "pending")
      .order("due_at", { ascending: true })
      .limit(25),
  ]);

  if (leadResult.error) throw new Error(leadResult.error.message);
  if (messageResult.error) throw new Error(messageResult.error.message);
  if (followUpResult.error) throw new Error(followUpResult.error.message);

  const leads = leadResult.data || [];
  const messages = messageResult.data || [];
  const followUps = followUpResult.data || [];
  const localities = new Map<string, number>();

  for (const row of leads) {
    const locality = String(row.location_hint || "").trim();
    if (!locality) continue;
    localities.set(locality, (localities.get(locality) || 0) + 1);
  }

  return {
    days,
    leads_total: leads.length,
    listings_total: leads.filter((row) => row.record_type === "inventory_listing").length,
    requirements_total: leads.filter((row) => row.record_type === "buyer_requirement").length,
    p1_total: 0,
    messages_total: messages.length,
    active_chats: new Set(messages.map((row) => row.remote_jid).filter(Boolean)).size,
    pending_follow_ups: followUps.length,
    next_follow_up: followUps[0] || null,
    top_localities: [...localities.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([locality, count]) => ({ locality, count })),
  };
}

export async function getHotLeadTriage(input: { brokerId: string; days?: number; limit?: number }) {
  const days = Math.min(Math.max(input.days ?? 7, 1), 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [leadResult, followUpResult, messageResult] = await Promise.all([
    supabase
      .from("lead_records")
      .select("lead_id, name, phone, record_type, location_hint, budget, raw_text, created_at, updated_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false, nullsFirst: false })
      .limit(100),
    supabase
      .from("follow_up_tasks")
      .select("lead_id, lead_name, lead_phone, due_at, status, priority_bucket, notes")
      .eq("tenant_id", input.brokerId)
      .eq("status", "pending")
      .order("due_at", { ascending: true })
      .limit(100),
    supabase
      .from("messages")
      .select("remote_jid, text, sender, timestamp, created_at")
      .eq("tenant_id", input.brokerId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (leadResult.error) throw new Error(leadResult.error.message);
  if (followUpResult.error) throw new Error(followUpResult.error.message);
  if (messageResult.error) throw new Error(messageResult.error.message);

  const leads = leadResult.data || [];
  const followUps = followUpResult.data || [];
  const messages = messageResult.data || [];
  const now = Date.now();
  const followUpByLeadId = new Map<string, typeof followUps[number]>();
  const followUpByPhone = new Map<string, typeof followUps[number]>();

  for (const item of followUps) {
    if (item.lead_id) followUpByLeadId.set(item.lead_id, item);
    if (item.lead_phone) followUpByPhone.set(item.lead_phone, item);
  }

  const scored = leads.map((lead) => {
    const followUp = (lead.lead_id && followUpByLeadId.get(lead.lead_id))
      || (lead.phone && followUpByPhone.get(lead.phone))
      || null;
    const leadText = String(lead.raw_text || "").toLowerCase();
    const recentMessageCount = messages.filter((message) => {
      const text = String(message.text || "").toLowerCase();
      return (
        text.includes((lead.phone || "").replace(/[^\d]/g, "").slice(-6))
        || (lead.name && text.includes(String(lead.name).toLowerCase()))
        || (lead.location_hint && text.includes(String(lead.location_hint).toLowerCase()))
      );
    }).length;

    let score = 0;

    if (/\b(site visit|visit|inspection|closing|token|final|urgent|asap|immediate)\b/i.test(leadText)) {
      score += 10;
    }

    if (followUp?.due_at) {
      const dueAt = new Date(followUp.due_at).getTime();
      if (!Number.isNaN(dueAt)) {
        if (dueAt <= now) score += 18;
        else if (dueAt - now <= 24 * 60 * 60 * 1000) score += 10;
      }
    } else {
      score += 6;
    }

    score += Math.min(recentMessageCount * 2, 10);

    const why = [
      followUp?.due_at
        ? new Date(followUp.due_at).getTime() <= now
          ? "follow-up overdue"
          : "follow-up scheduled"
        : "no follow-up booked",
      recentMessageCount > 0 ? `${recentMessageCount} recent message signals` : null,
    ].filter(Boolean) as string[];

    return {
      lead_id: lead.lead_id,
      name: lead.name || followUp?.lead_name || "Unknown lead",
      phone: lead.phone || followUp?.lead_phone || null,
      record_type: lead.record_type,
      location: lead.location_hint || null,
      budget: lead.budget ?? null,
      priority_bucket: null,
      urgency: null,
      due_at: followUp?.due_at || null,
      score,
      why,
      next_action: followUp?.due_at
        ? "Call or message this lead before the due follow-up slips further."
        : "Book a follow-up now and confirm exact budget, locality, and timeline.",
      raw_text: lead.raw_text || null,
    };
  });

  const items = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, clampLimit(input.limit, 10, 25));

  return {
    days,
    total_candidates: leads.length,
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
    .from("follow_up_tasks")
    .select("lead_id, lead_name, lead_phone, action_type, due_at, status, notes, priority_bucket, created_at")
    .eq("tenant_id", input.brokerId)
    .eq("status", "pending")
    .order("due_at", { ascending: true })
    .limit(clampLimit(input.limit, 25, 100));

  if (error) throw new Error(error.message);
  return data || [];
}

export async function getRecentSavedListings(input: { brokerId: string; limit?: number }) {
  const { data, error } = await supabase
    .from("listings")
    .select("id, structured_data, raw_text, created_at")
    .eq("tenant_id", input.brokerId)
    .order("created_at", { ascending: false })
    .limit(clampLimit(input.limit, 20, 100));

  if (error) throw new Error(error.message);
  return (data || []) as Array<{
    id: string;
    structured_data: Record<string, unknown> | null;
    raw_text: string | null;
    created_at: string | null;
  }>;
}

export async function getRecentRequirements(input: { brokerId: string; limit?: number }) {
  const { data, error } = await supabase
    .from("lead_records")
    .select("lead_id, name, phone, location_hint, locality_canonical, budget, raw_text, created_at")
    .eq("tenant_id", input.brokerId)
    .eq("record_type", "buyer_requirement")
    .order("created_at", { ascending: false })
    .limit(clampLimit(input.limit, 20, 100));

  if (error) throw new Error(error.message);
  return (data || []) as Array<{
    lead_id: string;
    name: string;
    phone: string | null;
    location_hint: string | null;
    locality_canonical: string | null;
    budget: number | null;
    raw_text: string | null;
    created_at: string | null;
  }>;
}

export async function getStoredThreadMessages(input: {
  brokerId: string;
  remoteJid?: string;
  limit?: number;
}) {
  let query = supabase
    .from("messages")
    .select("remote_jid, text, sender, timestamp, created_at")
    .eq("tenant_id", input.brokerId)
    .order("timestamp", { ascending: false, nullsFirst: false })
    .limit(clampLimit(input.limit, 40, 200));

  if (input.remoteJid) {
    query = query.eq("remote_jid", input.remoteJid);
  } else {
    query = query.not("remote_jid", "is", null);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as Array<{
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
  let query = supabase
    .from("public_listings")
    .select(PUBLIC_LISTING_COLUMNS)
    .gte("message_timestamp", since)
    .order("message_timestamp", { ascending: false, nullsFirst: false })
    .limit(clampLimit(input.limit, 200, 500));

  query = applyLocality(query, input.locality, input.city);
  query = applyListingType(query, input.property_type);
  if (input.bhk != null) {
    query = query.eq("bhk", input.bhk);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = normalizePublicListings(data || []);

  const prices = rows.map((row) => row.price).filter((value): value is number => value != null);
  const ppsf = rows
    .map((row) => row.price != null && row.size_sqft ? row.price / row.size_sqft : null)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const localityCounts = new Map<string, number>();
  for (const row of rows) {
    const locality = String(row.sub_area || row.area || row.location || "").trim();
    if (!locality) continue;
    localityCounts.set(locality, (localityCounts.get(locality) || 0) + 1);
  }

  return {
    days,
    listing_count: rows.length,
    avg_price_cr: prices.length ? Number((prices.reduce((sum, value) => sum + value, 0) / prices.length).toFixed(2)) : null,
    median_price_cr: median(prices),
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
  const igr = await getIgrPrice({
    building_name: input.building_name,
    locality: input.locality,
  });

  const publicPpsf = market.avg_price_per_sqft;
  const igrPpsf = igr.locality_stats?.avg_price_per_sqft ?? null;
  const referencePpsf = publicPpsf || igrPpsf || null;
  const estimatedPriceCr = referencePpsf && input.area_sqft
    ? Number(((referencePpsf * input.area_sqft) / 10000000).toFixed(2))
    : market.median_price_cr;

  return {
    estimated_price_cr: estimatedPriceCr,
    reference_price_per_sqft: referencePpsf,
    public_market: market,
    igr_market: igr.locality_stats,
    igr_transaction: igr.transaction,
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
  const igrRate = estimate.igr_market?.avg_price_per_sqft ?? null;
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
    return "Use IGR and current comparables to test the ask before taking a hard negotiation stance.";
  })();

  const leveragePoints = [
    publicRate != null ? `Public comparable rate around ${formatPerSqft(publicRate)}` : null,
    igrRate != null ? `IGR-backed locality rate around ${formatPerSqft(igrRate)}` : null,
    askingPrice != null && estimatedPrice != null
      ? `Ask is ${deltaCr && deltaCr > 0 ? `${formatCurrencyCr(deltaCr)} above` : deltaCr && deltaCr < 0 ? `${formatCurrencyCr(Math.abs(deltaCr))} below` : "roughly at"} the estimated market value`
      : null,
    estimate.igr_transaction?.reg_date
      ? `Recent IGR transaction on ${formatDate(estimate.igr_transaction.reg_date)}`
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
    igr_market: estimate.igr_market,
    igr_transaction: estimate.igr_transaction,
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
      .from("lead_records")
      .select("lead_id, name, phone, record_type, location_hint, budget, raw_text, created_at, updated_at")
      .eq("tenant_id", input.brokerId)
      .lt("updated_at", cutoffIso)
      .order("updated_at", { ascending: true, nullsFirst: false })
      .limit(100),
    supabase
      .from("follow_up_tasks")
      .select("lead_id, lead_name, lead_phone, due_at, status, notes")
      .eq("tenant_id", input.brokerId)
      .order("due_at", { ascending: false })
      .limit(200),
  ]);

  if (leadResult.error) throw new Error(leadResult.error.message);
  if (followUpResult.error) throw new Error(followUpResult.error.message);

  const followUps = followUpResult.data || [];
  const followUpByLeadId = new Map<string, typeof followUps[number]>();
  const followUpByPhone = new Map<string, typeof followUps[number]>();

  for (const item of followUps) {
    if (item.lead_id) followUpByLeadId.set(item.lead_id, item);
    if (item.lead_phone) followUpByPhone.set(item.lead_phone, item);
  }

  const items = (leadResult.data || [])
    .map((lead) => {
      const followUp = (lead.lead_id && followUpByLeadId.get(lead.lead_id))
        || (lead.phone && followUpByPhone.get(lead.phone))
        || null;
      const lastTouchedAt = lead.updated_at || lead.created_at;
      const staleForDays = lastTouchedAt
        ? Math.max(1, Math.floor((Date.now() - new Date(lastTouchedAt).getTime()) / (24 * 60 * 60 * 1000)))
        : staleDays;

      let score = staleForDays;

      if (lead.record_type === "buyer_requirement") score += 8;
      if (!followUp || followUp.status !== "pending") score += 6;

      const why = [
        `${staleForDays} days stale`,
        lead.record_type === "buyer_requirement" ? "buyer-side lead" : "inventory-side lead",
        !followUp || followUp.status !== "pending" ? "no active follow-up" : "follow-up exists",
      ].filter(Boolean) as string[];

      const location = lead.location_hint || null;
      const budgetText = lead.budget != null ? formatCurrencyCr(lead.budget) : null;
      const rawText = String(lead.raw_text || "").trim();
      const opener = lead.record_type === "buyer_requirement"
        ? `Hi ${lead.name || "there"}, circling back on your ${location || "property"} requirement. Still active, or has the brief changed?`
        : `Hi ${lead.name || "there"}, checking whether your ${location || "listing"} is still active and if pricing or availability has shifted.`;

      return {
        lead_id: lead.lead_id,
        name: lead.name || "Unknown lead",
        phone: lead.phone || null,
        record_type: lead.record_type,
        location,
        budget: budgetText,
        stale_for_days: staleForDays,
        score,
        why,
        recommended_channel: lead.phone ? "whatsapp_or_call" : "manual_review",
        reactivation_opener: opener,
        next_action: lead.phone
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
      .from("lead_records")
      .select("lead_id")
      .eq("tenant_id", input.brokerId)
      .eq("phone", phone)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    existingLeadId = data?.lead_id || null;
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

  const fetchRows = async (table: string) => {
    let query = supabase
      .from(table as any)
      .select(STREAM_INTEL_COLUMNS)
      .eq("ingestion_status", "accepted")
      .gte("created_at", since);

    const buildingTokens = normalizedBuilding.split(/\s+/).filter(Boolean);
    for (const token of buildingTokens) {
      query = query.ilike("building_name", `%${token}%`);
    }
    if (input.locality) {
      query = query.ilike("locality", `%${normalizeLocality(input.locality)}%`);
    }
    const { data, error } = await query;
    return error ? [] : (data as any[] || []);
  };

  const [residential, commercial] = await Promise.all([
    fetchRows("stream_items_residential"),
    fetchRows("stream_items_commercial"),
  ]);

  const allRows = [...residential, ...commercial];

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

export async function getListingById(listingId: string) {
  const { data, error } = await supabase
    .from("public_listings")
    .select(PUBLIC_LISTING_COLUMNS)
    .eq("source_message_id", listingId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const normalized = normalizePublicListings([data]);
  return normalized.length ? normalized[0] : null;
}

export async function searchBrokers(input: {
  city?: string;
  locality?: string;
  specialization?: string;
  limit?: number;
}) {
  const limit = clampLimit(input.limit, 20, 100);
  const query = supabase
    .from("profiles")
    .select("id, full_name, phone, email, city, locations, agency_name, app_role");

  const orConditions: string[] = [];
  if (input.locality) {
    orConditions.push(`locations.cs.{${input.locality}}`);
    orConditions.push(`city.ilike.%${input.locality}%`);
  }
  if (input.city) {
    orConditions.push(`city.ilike.%${input.city}%`);
  }
  if (orConditions.length) {
    query.or(orConditions.join(","));
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(error.message);

  return (data || [])
    .filter((p: { app_role?: string }) => p.app_role === "broker" || p.app_role === "super_admin");
}
