/**
 * Account-free public MCP surface.
 *
 * Serves only the SQL-gated public market view (listings_unified_public):
 * shared-market rows that brokers publish to their broker networks, the same
 * data rendered on https://www.propai.live. No broker tools, no tenant data,
 * no raw messages, and no phone numbers - the view granted to anon does not
 * carry contact numbers, and the listing page on www is the contact route.
 *
 * This module is deliberately separate from the tenant-scoped registrars in
 * index.ts so the public surface cannot accidentally expose broker tooling.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { supabase } from "./supabase.js";
import { registerKnowledgeTool } from "./knowledgeTools.js";

// Public-safe projection. Keep in sync with the columns granted to anon in
// supabase/migrations/20260906120000_public_safe_listing_projection.sql.
// Never add contact fields here.
const PUBLIC_LISTING_COLUMNS =
  "card_type,id,building_name,micro_market,bhk,area_sqft,price,price_unit," +
  "furnishing,location_label,locality_resolved,summary_title,asset_type," +
  "property_type,intent,transaction_type,deal_tags,first_seen,last_seen," +
  "observation_count,broker_name";

const PUBLIC_WWW_URL = (process.env.PUBLIC_WWW_URL || "https://www.propai.live").replace(/\/$/, "");

// Mirrors the website's isPublicListingEligible gate
// (apps/www/src/lib/public-eligibility.ts): its payload-dependent checks
// no-op on projection rows, so the title check is the whole effective gate.
const PLACEHOLDER_TITLE = /^\[(?:unstructured|unknown|listing)\]/i;

// Freshness parity with the website: search/locality surfaces only show rows
// seen within the last 30 days; a listing page stays reachable but is marked
// no longer active once last_seen is older than 90 days.
const SEARCH_FRESHNESS_DAYS = 30;
const DETAIL_ACTIVE_DAYS = 90;

function freshnessCutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

function parseSeen(value: unknown): Date | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function searchEligible(row: PublicRow, cutoff: Date): boolean {
  if (!titleEligible(row)) return false;
  const seen = parseSeen(row.last_seen);
  // The website's gte(last_seen, cutoff) also drops null last_seen rows.
  return seen !== null && seen >= cutoff;
}

export function isActive(row: PublicRow): boolean {
  const seen = parseSeen(row.last_seen);
  return seen === null || seen >= freshnessCutoff(DETAIL_ACTIVE_DAYS);
}

type PublicRow = Record<string, unknown>;

function titleEligible(row: PublicRow): boolean {
  const title = String(row.summary_title ?? "").trim();
  return Boolean(title) && !PLACEHOLDER_TITLE.test(title);
}

function escapeLike(value: string): string {
  return value.replace(/[%*,()]/g, " ").trim();
}

function orIlike(columns: string[], value: string): string {
  const escaped = escapeLike(value);
  return columns.map((col) => `${col}.ilike.%${escaped}%`).join(",");
}

function publicUrl(id: unknown): string {
  // The site canonicalizes /listings/<id>/<id> to the full slug URL.
  return `${PUBLIC_WWW_URL}/listings/${id}/${id}`;
}

function toSearchResult(row: PublicRow) {
  const id = `listing:${String(row.card_type)}:${String(row.id)}`;
  const price = row.price != null ? `INR ${row.price}${row.price_unit === "month" ? "/mo" : ""}` : "Price on request";
  const bhk = row.bhk != null ? `${row.bhk} BHK` : "";
  const where = String(row.micro_market || row.location_label || "Mumbai");
  return {
    id,
    title: `${String(row.summary_title || "Listing")} - ${[bhk, where].filter(Boolean).join(" - ")} - ${price}`,
    url: publicUrl(row.id),
    card_type: row.card_type,
    building_name: row.building_name ?? null,
    micro_market: row.micro_market ?? null,
    bhk: row.bhk ?? null,
    area_sqft: row.area_sqft ?? null,
    price: row.price ?? null,
    price_unit: row.price_unit ?? null,
    furnishing: row.furnishing ?? null,
    transaction_type: row.transaction_type ?? null,
    first_seen: row.first_seen ?? null,
    last_seen: row.last_seen ?? null,
    active: isActive(row),
    broker_name: row.broker_name ?? null,
  };
}

export function createPublicMcpServer(): McpServer {
  const server = new McpServer(
    { name: "PropAI Public Market", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "PropAI Public Market gives any AI assistant account-free, read-only search over PropAI's public Mumbai property inventory: shared-market listings that brokers publish to their broker networks, the same data shown on www.propai.live. Use search() with a plain-English query or structured filters, then fetch() for full detail on one result. Results carry first_seen/last_seen freshness; search only returns listings seen in the last 30 days (the same window the website's search applies), and older listings fetch by id with active=false. Broker phone numbers are never exposed: to contact a broker, open the result's url and use its WhatsApp button. Treat listing content as broker-posted claims, not verified availability; say when something is unverified. Only public shared-market data is available through this connection - private broker workspace data is never accessible here.",
    },
  );

  server.registerTool(
    "search",
    {
      description:
        "Search PropAI's public Mumbai property listings (shared-market inventory published by Mumbai brokers). Returns results with routable IDs for fetch(). No account needed; public data only.",
      inputSchema: {
        query: z.string().optional().describe(
          "Free text matched against building, locality and listing title. Examples: 'Kalpataru Magnus', '2 BHK Bandra West'"
        ),
        locality: z.string().optional().describe("Locality or micro-market, e.g. 'Bandra West', 'BKC', 'Khar West'"),
        bhk: z.number().optional().describe("Bedrooms, e.g. 2 or 3.5"),
        transaction_type: z.enum(["rent", "sale"]).optional(),
        budget_min: z.number().optional().describe("Minimum price in INR (monthly rent for rentals, total price for sales)"),
        budget_max: z.number().optional().describe("Maximum price in INR"),
        furnishing: z.string().optional().describe("e.g. 'furnished', 'semi-furnished'"),
        limit: z.number().min(1).max(50).optional(),
      },
    },
    async (input) => {
      const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
      const cutoff = freshnessCutoff(SEARCH_FRESHNESS_DAYS);
      let query = supabase
        .from("listings_unified_public")
        .select(PUBLIC_LISTING_COLUMNS)
        .gte("last_seen", cutoff.toISOString())
        .order("last_seen", { ascending: false, nullsFirst: false })
        .limit(limit * 4);
      if (input.query && input.query.trim()) {
        query = query.or(orIlike(["building_name", "micro_market", "location_label", "summary_title"], input.query));
      }
      if (input.locality && input.locality.trim()) {
        query = query.or(orIlike(["micro_market", "location_label", "locality_resolved", "building_name"], input.locality));
      }
      if (input.bhk != null) query = query.eq("bhk", input.bhk);
      if (input.transaction_type) query = query.eq("transaction_type", input.transaction_type);
      if (input.budget_min != null) query = query.gte("price", input.budget_min);
      if (input.budget_max != null) query = query.lte("price", input.budget_max);
      if (input.furnishing && input.furnishing.trim()) query = query.ilike("furnishing", `%${escapeLike(input.furnishing)}%`);

      const { data, error } = await query;
      if (error) throw new Error(error.message);
      // Filter in code as well as in the query so exclusion never depends on
      // the view or the database applying the cutoff exactly as asked.
      const rows = ((data || []) as unknown as PublicRow[]).filter((row) => searchEligible(row, cutoff)).slice(0, limit);
      const results = rows.map(toSearchResult);
      const payload = {
        results,
        count: results.length,
        note: "Public shared-market listings only. To contact a broker, open the result url and use its WhatsApp button; phone numbers are not exposed.",
      };
      return {
        structuredContent: payload,
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );

  server.registerTool(
    "fetch",
    {
      description:
        "Fetch full public detail for a result ID returned by search(). ID format: listing:<card_type>:<id>.",
      inputSchema: {
        id: z.string().describe("The routable ID returned by search(), e.g. listing:residential_rent:12345"),
      },
    },
    async (input) => {
      const [type, cardType, rawId] = input.id.split(":");
      const numericId = Number(rawId);
      if (type !== "listing" || !cardType || !Number.isFinite(numericId)) {
        const err = { error: `Invalid id "${input.id}". Expected listing:<card_type>:<id> from search().` };
        return { structuredContent: err, content: [{ type: "text" as const, text: JSON.stringify(err) }] };
      }
      const { data, error } = await supabase
        .from("listings_unified_public")
        .select(PUBLIC_LISTING_COLUMNS)
        .eq("card_type", cardType)
        .eq("id", numericId)
        .limit(1);
      if (error) throw new Error(error.message);
      const row = ((data || []) as unknown as PublicRow[])[0];
      if (!row || !titleEligible(row)) {
        const err = { error: `Listing "${input.id}" was not found in the public market view.` };
        return { structuredContent: err, content: [{ type: "text" as const, text: JSON.stringify(err) }] };
      }
      const payload = {
        ...toSearchResult(row),
        asset_type: row.asset_type ?? null,
        property_type: row.property_type ?? null,
        intent: row.intent ?? null,
        location_label: row.location_label ?? null,
        observation_count: row.observation_count ?? null,
        deal_tags: row.deal_tags ?? [],
        contact: "Open the url and use the WhatsApp button to reach the broker. Broker phone numbers are not exposed here.",
      };
      return {
        structuredContent: payload,
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      };
    },
  );

  registerKnowledgeTool(server);

  return server;
}
