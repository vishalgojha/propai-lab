import crypto from "node:crypto";
import { z } from "zod";

/**
 * Query-time broker property cross-search policy for the existing broker MCP
 * (/raw-mcp). This is a line-by-line port of the reviewed Python reference
 * implementation (api/routers/broker_market_policy.py, consent version
 * broker-property-cross-search-v1). The REST API and this MCP adapter must
 * stay byte-compatible: same canonical JSON (sorted keys, compact), same
 * base64url-no-padding body, same HMAC-SHA256 hex signature, same consent
 * strings, same masking.
 *
 * No extraction, replication, or source-name fallback. Hidden hash inputs
 * (sender identity) are never returned to callers.
 */

export const CONSENT_VERSION = "broker-property-cross-search-v1";
export const CONSENT_TEXT =
  "Allow other authenticated PropAI brokers' AI agents to cross-search the message text " +
  "in these selected groups for property-related requests. Data stays in your account. " +
  "A matching message may include discussion as well as property details. DMs and unchecked " +
  "groups stay private. Untick to stop future cross-search access. Contact numbers are " +
  "hidden until a broker chooses a specific option.";
export const CONTACT_NOTICE =
  "Numbers are hidden to avoid bulk exposure and unwanted calls. This is not a paywall. " +
  "Choose one specific option to request its contact.";

// Matching-purpose restriction, not a semantic privacy filter. The original text can be mixed.
// Kept identical to the Python pattern; it is executed inside the SQL RPC, not in JS.
export const PROPERTY_PATTERN =
  "\\m(bhk|bedroom|bedrooms|flat|flats|apartment|apartments|penthouse|villa|bungalow|office|offices|shop|shops|warehouse|plot|carpet|sqft|sq[ .]?ft|sq[ .]?m|lease|rent|rental|sale|resale|possession|furnished|unfurnished|crore|cr|lakh|lac)\\M";

export const OPTION_TTL_SECONDS = 1800;

const PROPERTY_TYPES = ["apartment", "penthouse", "villa", "bungalow", "office", "shop", "warehouse", "plot"] as const;
const TRANSACTIONS = ["sale", "rent", "lease", "requirement"] as const;

/**
 * Python's \w (re.UNICODE) matches letters (\p{L}), decimal/other numbers
 * (\p{N}) and underscore - NOT combining marks - while JS \w is ASCII-only.
 * Keep this class aligned with the Python validator.
 */
const NAME_RE = /^[\p{L}\p{N}_ .,'()&/-]+$/u;
/** Python rejects 7+ digit runs (contacts) in name fields. \d approximated as \p{Nd}. */
const DIGITS_RE = /\p{Nd}(?:[ .()-]?\p{Nd}){6,}/u;

function normalizeNameField(field: "building" | "locality", raw: string): string {
  const value = String(raw ?? "").normalize("NFKC").trim();
  if (
    value &&
    (value.length < 2 ||
      !NAME_RE.test(value) ||
      DIGITS_RE.test(value) ||
      ["%", "_", "@", ":", "\n"].some((c) => value.includes(c)))
  ) {
    throw new MarketValidationError(`${field} must be a building or locality name, not a contact or general query`);
  }
  return value;
}

export class MarketValidationError extends Error {}
export class MarketReferenceError extends Error {}

export const propertySearchSchema = z
  .object({
    building: z.string().max(100).default(""),
    locality: z.string().max(100).default(""),
    property_type: z.enum(PROPERTY_TYPES).nullable().default(null),
    transaction: z.enum(TRANSACTIONS).nullable().default(null),
    bedrooms: z.number().int().min(1).max(20).nullable().default(null),
    // Bounds limit the source history searched, not property price. Price in raw text
    // has varying units and must be interpreted by the requesting agent, not invented here.
    days: z.number().int().min(1).max(90).default(30),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z.string().max(1800).default(""),
  })
  .strict();

export type PropertySearchInput = z.infer<typeof propertySearchSchema>;

/** Validation plus normalization, mirroring PropertySearch.model_validator. */
export function parsePropertySearch(raw: unknown): PropertySearchInput {
  let parsed: PropertySearchInput;
  try {
    parsed = propertySearchSchema.parse(raw ?? {});
  } catch (e) {
    throw new MarketValidationError(e instanceof Error ? e.message : "Invalid property criteria");
  }
  parsed.building = normalizeNameField("building", parsed.building);
  parsed.locality = normalizeNameField("locality", parsed.locality);
  const criteria = [parsed.property_type, parsed.transaction, parsed.bedrooms].filter((v) => v !== null).length;
  if (!(parsed.building || parsed.locality || criteria >= 2)) {
    throw new MarketValidationError(
      "Provide a building/locality or at least two property criteria; general browsing is not supported",
    );
  }
  return parsed;
}

/**
 * String escaping identical to Python json.dumps (ensure_ascii=True):
 * standard short escapes, \u00XX for other control characters, and every
 * non-ASCII character as \uXXXX UTF-16 code units (astral chars become
 * surrogate pairs, exactly like CPython). JSON.stringify leaves non-ASCII
 * raw, which would diverge from the Python reference byte-for-byte.
 */
export function pyJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = value[i];
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code > 0x7e) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

function pyJsonScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return pyJsonString(value);
  return JSON.stringify(value); // numbers/booleans are ASCII-only in both implementations
}

/** Canonical JSON exactly as Python json.dumps(..., sort_keys=True, separators=(",", ":")). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return pyJsonScalar(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${pyJsonString(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Python json.dumps(..., sort_keys=True) WITHOUT compact separators (", " and ": ") — used by fingerprint() only. */
function spacedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return pyJsonScalar(value);
  if (Array.isArray(value)) return `[${value.map(spacedJson).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${pyJsonString(k)}: ${spacedJson(v)}`).join(", ")}}`;
}

/**
 * sha256 of the sorted-key dump with cursor and limit excluded, matching
 * PropertySearch.fingerprint() (note: the Python reference uses json.dumps
 * default separators here, not the compact form seal() uses).
 */
export function searchFingerprint(body: PropertySearchInput): string {
  const dump = {
    bedrooms: body.bedrooms,
    building: body.building,
    days: body.days,
    locality: body.locality,
    property_type: body.property_type,
    transaction: body.transaction,
  };
  return crypto.createHash("sha256").update(spacedJson(dump), "utf8").digest("hex");
}

/** Same alias groups as the Python terms(). */
export function searchTerms(body: PropertySearchInput): string[][] {
  const groups: string[][] = [];
  for (const value of [body.building, body.locality]) {
    if (value) groups.push([value.toLowerCase()]);
  }
  const aliases: Record<string, string[]> = {
    apartment: ["apartment", "flat", "bhk", "bedroom"],
    sale: ["sale", "resale", "sell", "selling"],
    rent: ["rent", "rental", "lease"],
    requirement: ["required", "requirement", "looking for", "wanted", "need"],
  };
  for (const value of [body.property_type, body.transaction]) {
    if (value) groups.push(aliases[value] ?? [value]);
  }
  if (body.bedrooms !== null) {
    const n = body.bedrooms;
    groups.push([`${n}bhk`, `${n} bhk`, `${n} bedroom`, `${n} bed`]);
  }
  return groups;
}

/** Conservative output boundary; labels, payloads and sender identity are not returned. */
export function redactContacts(text: unknown): string {
  let out = String(text ?? "").normalize("NFKC");
  out = out.replace(/(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|t\.me)\/\S+/gi, "[link hidden]");
  out = out.replace(/\b[\w.+-]+@[\w.-]+(?:\.[a-z]{2,}|\.net|\.us)\b/gi, "[contact hidden]");
  // Covers separated international/national numbers and digit-bearing WhatsApp JIDs.
  out = out.replace(/(?<![\p{L}\p{N}_])\+?\p{Nd}(?:[\s().-]*\p{Nd}){6,}(?!\p{Nd})(?:@[\w.]+)?/gu, "[number hidden]");
  return out;
}

type SealPayload = Record<string, unknown> & { kind: string; reader: string; exp: number };

/** base64url(canonical JSON) without padding + "." + HMAC-SHA256 hex; identical to the Python seal(). */
export function seal(payload: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error("Market signing secret is not configured");
  const body = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `${body}.${signature}`;
}

/** Identical checks to the Python unseal(): signature, kind, reader and expiry. */
export function unseal(token: string, secret: string, opts: { kind: string; reader: string }): SealPayload {
  if (!secret) throw new Error("Market signing secret is not configured");
  const fail = (): never => {
    throw new MarketReferenceError("Invalid or expired market reference");
  };
  const parts = String(token ?? "").split(".");
  if (parts.length !== 2) fail();
  const [body, supplied] = parts;
  const expected = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  const suppliedBuf = Buffer.from(supplied, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (suppliedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(suppliedBuf, expectedBuf)) fail();
  let value: SealPayload;
  try {
    value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return fail();
  }
  if (
    !value ||
    typeof value !== "object" ||
    value.kind !== opts.kind ||
    value.reader !== opts.reader ||
    typeof value.exp !== "number" ||
    value.exp < Date.now() / 1000
  ) {
    fail();
  }
  return value;
}

export type SearchBounds = { since: string; until: string; lastId: number | null; lastAt: string | null };

/** Mirrors search_bounds(): a cursor pins the original window and page position. */
export function searchBounds(body: PropertySearchInput, cursor: SealPayload | null): SearchBounds {
  if (cursor) {
    if (cursor.query !== searchFingerprint(body)) {
      throw new MarketValidationError("Cursor belongs to another property query");
    }
    return {
      since: String(cursor.since),
      until: String(cursor.until),
      lastId: cursor.last_id as number,
      lastAt: String(cursor.last_at),
    };
  }
  const until = new Date();
  const since = new Date(until.getTime() - body.days * 24 * 60 * 60 * 1000);
  return { since: since.toISOString(), until: until.toISOString(), lastId: null, lastAt: null };
}

/** sha256(body|sender_phone|sender_jid); inputs stay server-side. Mirrors source_hash(). */
export function sourceHash(row: { body: unknown; sender_phone?: unknown; sender_jid?: unknown }): string {
  return crypto
    .createHash("sha256")
    .update(`${String(row.body ?? "")}|${String(row.sender_phone ?? "")}|${String(row.sender_jid ?? "")}`, "utf8")
    .digest("hex");
}

const CONTACT_RE = /(?<!\d)(?:\+?91[ .-]?|0)?[6-9]\d{4}[ .-]?\d{5}(?!\d)/g;

/** Labelled contact candidates from one original message. Mirrors contact_choices(). */
export function contactChoices(row: { body?: unknown; sender_phone?: unknown }): Array<{ digits: string; label: string }> {
  const text = String(row.body ?? "").normalize("NFKC");
  const values: Array<{ digits: string; label: string }> = [];
  for (const match of text.matchAll(CONTACT_RE)) {
    const digits = match[0].replace(/\D/g, "").slice(-10);
    if (values.some((v) => v.digits === digits)) continue;
    const at = match.index ?? 0;
    const safe = redactContacts(`${text.slice(0, at)} CONTACTCHOICE ${text.slice(at + match[0].length)}`);
    const pos = safe.indexOf("CONTACTCHOICE");
    const snippet = safe.slice(Math.max(0, pos - 45), pos + 65).replaceAll("CONTACTCHOICE", "(this contact)");
    values.push({ digits, label: snippet });
  }
  if (!values.length) {
    const number = String(row.sender_phone ?? "").replace(/\D/g, "");
    if (/^(?:91)?[6-9]\d{9}$/.test(number)) {
      values.push({ digits: number.slice(-10), label: "Message poster, not necessarily the property's broker or owner" });
    }
  }
  return values;
}
