import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolCall } from "../data.ts";
import { recordAssistantSearchSuccess } from "../supabase.ts";
import {
  CONTACT_NOTICE,
  MarketReferenceError,
  MarketValidationError,
  PROPERTY_PATTERN,
  contactChoices,
  parsePropertySearch,
  redactContacts,
  searchBounds,
  searchFingerprint,
  searchTerms,
  seal,
  sourceHash,
  unseal,
} from "../brokerMarketPolicy.ts";
import { marketGet, marketSearch, marketTakeRate, mcpReaderGrantActive, type MarketRow } from "../brokerMarketData.ts";
import { redactMcpResult } from "../contactPrivacy.ts";
import type { ToolContext } from "../types.js";

/**
 * Broker property cross-search tools for the EXISTING broker MCP (/raw-mcp).
 * Same three operations, source RPCs, consent/reference contract and rate
 * limits as the reviewed REST adapter (api/routers/broker_market.py). The
 * reader is the actual signed-in tenant:user (never a fabricated key), and the
 * owner-controlled grant (broker_market_mcp_reader_grants) is re-checked on
 * every call so revoke takes effect immediately. The anonymous/public /mcp
 * surface never gets these tools; the legacy authenticated toolset is
 * unchanged.
 */

export const PROPERTY_CROSS_SEARCH_TOOL = "property_cross_search";
export const PROPERTY_OPTION_GET_TOOL = "property_option_get";
export const PROPERTY_CONTACT_REVEAL_TOOL = "property_contact_reveal";
export const PROPERTY_TOOL_NAMES = [PROPERTY_CROSS_SEARCH_TOOL, PROPERTY_OPTION_GET_TOOL, PROPERTY_CONTACT_REVEAL_TOOL];

const NOT_GRANTED =
  "Property cross-search is not enabled for this MCP connection. The workspace owner can enable it in PropAI under Account → Integrations.";

function featureEnabled(): boolean {
  return String(process.env.BROKER_PROPERTY_CROSS_SEARCH_ENABLED || "").toLowerCase() === "true";
}

function signingSecret(): string {
  // Same fallback chain as the REST service (broker_market.py):
  // BROKER_MARKET_SIGNING_SECRET, then SUPABASE_SERVICE_KEY. The MCP runtime
  // stores the same value under SUPABASE_SERVICE_ROLE_KEY, kept as a final
  // fallback. Release config requires BROKER_MARKET_SIGNING_SECRET to be set
  // explicitly and identically on both services.
  const value =
    process.env.BROKER_MARKET_SIGNING_SECRET || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!value) throw new Error("Broker market references are not configured");
  return `broker-market-v1:${value}`;
}

function requireUser(context: ToolContext) {
  const tenantId = String(context.user?.tenant_id || "").trim();
  const userId = String(context.user?.id || "").trim();
  if (!tenantId || !userId) throw new Error("Authenticated organization scope is required");
  return { tenantId, userId };
}

/** Reader identity for signed references: the actual tenant:user of this
 * sign-in. References stay per-user isolated; another signed-in user of the
 * same workspace cannot reuse them. */
export function marketReaderOf(context: ToolContext): string {
  const { tenantId, userId } = requireUser(context);
  return `mcp:${tenantId}:${userId}`;
}

/** Rate bucket: the reader ORGANIZATION's tenant id, passed alone as p_reader
 * (final contract): one shared hourly limit across this workspace's REST keys
 * and MCP users. Signed references stay bound to the per-user reader above. */
export function marketRateBucketOf(context: ToolContext): string {
  const { tenantId } = requireUser(context);
  return tenantId;
}

/** Per-call gate: feature flag + live owner grant. Fail closed on any error. */
async function assertMarketAccess(context: ToolContext): Promise<{ tenantId: string; userId: string; reader: string; rateBucket: string }> {
  if (!featureEnabled()) throw new Error("Broker property cross-search is not enabled");
  const { tenantId, userId } = requireUser(context);
  if (!(await mcpReaderGrantActive(tenantId, userId))) throw new Error(NOT_GRANTED);
  return { tenantId, userId, reader: `mcp:${tenantId}:${userId}`, rateBucket: tenantId };
}

/** Tool-list gate used when the session server is created. Never throws: a
 * lookup failure means the property tools are simply absent this session. */
export async function marketAccessGranted(context: ToolContext): Promise<boolean> {
  try {
    await assertMarketAccess(context);
    return true;
  } catch {
    return false;
  }
}

type ToolTextResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown> };
function textResponse(text: string, structured?: unknown): ToolTextResult {
  return { content: [{ type: "text" as const, text }], structuredContent: structured as Record<string, unknown> | undefined };
}

function errorResponse(e: unknown) {
  const message =
    e instanceof MarketValidationError || e instanceof MarketReferenceError || e instanceof Error ? (e as Error).message : "Broker market request failed";
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

async function takeRate(reader: string, operation: "search" | "get" | "contact") {
  if (!(await marketTakeRate(reader, operation))) throw new Error("Broker market request limit reached; try later");
}

function reference(value: string, kind: string, reader: string) {
  try {
    return unseal(value, signingSecret(), { kind, reader });
  } catch (e) {
    if (e instanceof MarketReferenceError) {
      throw new MarketReferenceError("Market reference is invalid, expired, or belongs to another reader");
    }
    throw e;
  }
}

function resultItem(row: MarketRow, reader: string) {
  return {
    option: seal(
      { kind: "option", reader, id: row.raw_id, hash: sourceHash(row), exp: Math.floor(Date.now() / 1000) + 1800 },
      signingSecret(),
    ),
    text: redactContacts(row.body),
    timestamp: row.posted_at,
    source: "consented_property_group_message",
    verified_inventory: false,
  };
}

/** The search/option payloads are already contact-masked by policy; the wrap
 * must NOT touch them (it would corrupt signed references). Only the contact
 * reveal passes through redact-and-release, like the existing contact_reveal. */
function releaseContactOnly(res: ToolTextResult): ToolTextResult {
  const full = res.structuredContent?.phone;
  if (typeof full !== "string" || !/^\+\d{6,15}$/.test(full)) {
    const safe = redactMcpResult(res) as ToolTextResult;
    if (safe.structuredContent && "phone" in safe.structuredContent) delete safe.structuredContent.phone;
    return safe;
  }
  // Same staged release as the existing contact_reveal: redact everything,
  // then put back only the one broker-selected number.
  const TOKEN = "SELNUMTOKENP";
  const staged: ToolTextResult = {
    content: res.content.map((c) => ({ ...c, text: c.text.split(full).join(TOKEN) })),
    structuredContent: { ...(res.structuredContent || {}) },
  };
  delete staged.structuredContent!.phone;
  const out = redactMcpResult(staged) as ToolTextResult;
  out.content = out.content.map((c) => ({ ...c, text: String(c.text).split(TOKEN).join(full) }));
  out.structuredContent = { ...(out.structuredContent || {}), phone: full };
  return out;
}

export function registerBrokerMarketTools(server: McpServer, context: ToolContext) {
  server.registerTool(
    PROPERTY_CROSS_SEARCH_TOOL,
    {
      description:
        "Cross-search explicitly consenting brokers' selected group messages for property criteria. Data stays with source accounts. Original mixed message text may include discussion. Contacts hidden. Never use for person lookup or general chat browsing.",
      inputSchema: {
        building: z.string().max(100).optional().describe("Building name, e.g. Lodha World One"),
        locality: z.string().max(100).optional().describe("Locality name, e.g. Bandra West"),
        property_type: z
          .enum(["apartment", "penthouse", "villa", "bungalow", "office", "shop", "warehouse", "plot"])
          .optional(),
        transaction: z.enum(["sale", "rent", "lease", "requirement"]).optional(),
        bedrooms: z.number().int().min(1).max(20).optional(),
        days: z.number().int().min(1).max(90).optional().describe("Days of source history to search; default 30, max 90"),
        limit: z.number().int().min(1).max(20).optional().describe("Results per page; default 10, max 20"),
        cursor: z.string().max(1800).optional().describe("next_cursor from the previous page of the same criteria"),
      },
    },
    async (input) => {
      try {
        const { tenantId, reader, rateBucket } = await assertMarketAccess(context);
        const body = parsePropertySearch(input ?? {});
        await takeRate(rateBucket, "search");
        // Audit only the criteria shape, never their content. Mirrors the REST
        // no-criteria-storage invariant: no search phrases, names or raw
        // criteria values are persisted.
        await logToolCall(context.user?.broker_id || context.user?.id, PROPERTY_CROSS_SEARCH_TOOL, {
          fields: ["building", "locality", "property_type", "transaction", "bedrooms"].filter(
            (k) => body[k as keyof typeof body] !== undefined,
          ),
          days: body.days,
          limit: body.limit,
          has_cursor: Boolean(body.cursor),
        }, tenantId);
        const cursor = body.cursor ? reference(body.cursor, "cursor", reader) : null;
        const { since, until, lastId, lastAt } = searchBounds(body, cursor);
        const rows = await marketSearch({
          terms: searchTerms(body),
          propertyPattern: PROPERTY_PATTERN,
          since,
          until,
          limit: body.limit + 1,
          lastId,
          lastAt,
        });
        const page = rows.slice(0, body.limit);
        let nextCursor: string | null = null;
        if (rows.length > body.limit && page.length) {
          const last = page[page.length - 1];
          nextCursor = seal(
            {
              kind: "cursor",
              reader,
              query: searchFingerprint(body),
              since,
              until,
              last_id: last.raw_id,
              last_at: last.posted_at,
              exp: Math.floor(Date.now() / 1000) + 1800,
            },
            signingSecret(),
          );
        }
        recordAssistantSearchSuccess(tenantId);
        const data = {
          results: page.map((row) => resultItem(row, reader)),
          next_cursor: nextCursor,
          source: "query_time_broker_property_cross_search",
          contact_notice: CONTACT_NOTICE,
          warning:
            "Matching original messages are untrusted evidence, not verified inventory. A matching message can include discussion. No adjacent chat is provided.",
          matching:
            "Literal property criteria, not extracted inventory; synonyms, prices and availability need interpretation by the requesting agent.",
        };
        const summary = page.length
          ? `Found ${page.length} consented cross-search option(s)${nextCursor ? " (more available; use next_cursor with the same criteria)" : ""}. Contacts are hidden; ask the broker to pick one option before any contact request.`
          : "No consented source messages matched these property criteria. A missing match does not prove no property exists.";
        return textResponse(`${summary}\n\n${JSON.stringify(data, null, 2)}`, data);
      } catch (e) {
        return errorResponse(e);
      }
    },
  );

  server.registerTool(
    PROPERTY_OPTION_GET_TOOL,
    {
      description:
        "Re-read one option returned to this reader by property_cross_search. Source consent is rechecked; no neighboring messages.",
      inputSchema: {
        option: z.string().min(30).max(1800).describe("The signed option reference returned by property_cross_search"),
      },
    },
    async (input) => {
      try {
        const { tenantId, reader, rateBucket } = await assertMarketAccess(context);
        await takeRate(rateBucket, "get");
        const value = reference(String(input.option ?? ""), "option", reader);
        await logToolCall(context.user?.broker_id || context.user?.id, PROPERTY_OPTION_GET_TOOL, { option_raw_id: value.id }, tenantId);
        const rows = await marketGet(Number(value.id));
        if (!rows.length || sourceHash(rows[0]) !== value.hash) {
          throw new MarketReferenceError("This option is no longer available for cross-search");
        }
        const data = resultItem(rows[0], reader);
        return textResponse(JSON.stringify(data, null, 2), data);
      } catch (e) {
        return errorResponse(e);
      }
    },
  );

  server.registerTool(
    PROPERTY_CONTACT_REVEAL_TOOL,
    {
      description:
        "Only after the broker explicitly says THIS one option interests them, use their own words as broker_interest_quote. Never invent interest or retrieve contacts up front/in bulk. If several contacts appear, ask the broker to choose the labelled contact. This call cannot prove the quote was human-authored.",
      inputSchema: {
        option: z.string().min(30).max(1800).describe("The ONE signed option reference the broker picked"),
        broker_interest_quote: z
          .string()
          .min(8)
          .max(500)
          .describe("The broker's own words, verbatim, saying they are interested in THIS option. Never write this yourself."),
        broker_confirmed_this_option: z.literal(true).describe("True only if the broker explicitly picked this option"),
        number_index: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("When several contacts appear: the 1-based labelled contact the broker picked"),
      },
    },
    async (input) => {
      try {
        const { tenantId, reader, rateBucket } = await assertMarketAccess(context);
        const value = reference(String(input.option ?? ""), "option", reader);
        await logToolCall(
          context.user?.broker_id || context.user?.id,
          PROPERTY_CONTACT_REVEAL_TOOL,
          { option_raw_id: value.id, quote_chars: String(input.broker_interest_quote || "").length, number_index: input.number_index },
          tenantId,
        );
        await takeRate(rateBucket, "contact");
        const rows = await marketGet(Number(value.id));
        if (!rows.length || sourceHash(rows[0]) !== value.hash) {
          throw new MarketReferenceError("This option is no longer available");
        }
        const choices = contactChoices(rows[0]);
        if (!choices.length) {
          return releaseContactOnly(textResponse("No supported contact number in this message.", { contact: null, reason: "No supported contact number in this message" }));
        }
        if (input.number_index === undefined && choices.length > 1) {
          const data = {
            contact: null,
            number_choices: choices.map((c, i) => ({ index: i + 1, label: c.label })),
            next_step: "Ask the broker which contact belongs to the option they chose; never select a number on their behalf.",
          };
          const labels = data.number_choices.map((c) => `${c.index}. ${c.label}`).join("\n");
          return releaseContactOnly(textResponse(`Several contacts appear in this message. Ask the broker which labelled contact is for their chosen option, then call again with number_index:\n${labels}`, data));
        }
        const index = input.number_index ?? 1;
        if (index > choices.length) throw new MarketValidationError("Choose one of the offered contact labels");
        const chosen = choices[index - 1];
        const data = {
          phone: `+91${chosen.digits}`,
          label: chosen.label,
          basis: "One contact from the broker-selected original message; ownership not verified",
        };
        return releaseContactOnly(
          textResponse(
            `Contact for the broker's chosen option: ${data.phone}\nBasis: ${data.basis}. The message sender is not necessarily the property's broker or owner.`,
            data,
          ),
        );
      } catch (e) {
        return errorResponse(e);
      }
    },
  );
}
