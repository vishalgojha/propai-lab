/**
 * Staged contact reveal. First responses (every tool result and resource) never carry phone numbers,
 * WhatsApp links or phone-bearing JIDs: not in structured fields, not inside message text or URLs.
 * Matching evidence and source ids stay. A contact is released only by the explicit per-listing
 * contact_reveal tool (see tools/contact.ts), which is the one result exempt from redaction.
 */
export const HIDDEN = "[hidden until the broker confirms interest in this listing]";

/** Visible copy shown with any result that had a number hidden. Grounded in the user's stated rule, no incident claims. */
export const CONTACT_NOTICE =
  "Note: contact numbers are not shown in search results. This is to keep brokers' numbers from being exposed in bulk and to avoid unwanted calls. It is not a paywall. When you tell me which option looks interesting, I can share that one option's contact.";

const TEXT_PATTERNS: RegExp[] = [
  /\b\d{8,15}@(?:s\.whatsapp\.net|c\.us|lid)\b/gi,
  /(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|web\.whatsapp\.com\/send\?phone=)\+?\d+[^\s"')]*/gi,
  /tel:\+?[\d\s().-]{6,}/gi,
  /(?<![\d.])(?:\+|00)\s?\d{1,3}[\s.-]?\(?\d{2,5}\)?[\s.-]?\d{3,5}[\s.-]?\d{3,5}(?!\d)/g,
  /(?<![\d.,])(?:91[\s.-]?|0)?[6-9]\d{4}[\s.-]?\d{5}(?!\d)/g,
  /(?<![\d.,])(?:91[\s.-]?|0)?[6-9]\d{2}[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g,
];

export function redactText(value: string): string {
  let out = value;
  for (const re of TEXT_PATTERNS) out = out.replace(re, HIDDEN);
  return out;
}

const PHONE_KEY = /phone|mobile|msisdn|contact_number|contact_wa|wa_link|whatsapp_link|whatsapp_url|^wa$/i;

export function redactValue(value: unknown, key = ""): unknown {
  if (PHONE_KEY.test(key) && value !== null && value !== undefined && value !== "") return HIDDEN;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactValue(v, k)]));
  }
  return value;
}

/** Redact an MCP tool result or resource read result (content[].text, structuredContent, contents[].text). */
export function redactMcpResult<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, any>;
  const out: Record<string, any> = { ...r };
  for (const field of ["content", "contents"] as const) {
    if (Array.isArray(r[field])) {
      out[field] = r[field].map((item: any) => {
        if (!item || typeof item !== "object") return item;
        const next = { ...item };
        if (typeof next.text === "string") next.text = redactText(next.text);
        if (typeof next.uri === "string") next.uri = redactText(next.uri);
        if (typeof next.resource?.text === "string") next.resource = { ...next.resource, text: redactText(next.resource.text) };
        return next;
      });
    }
  }
  if (r.structuredContent !== undefined) out.structuredContent = redactValue(r.structuredContent);
  if (Array.isArray(out.content) && JSON.stringify(out).includes(HIDDEN)) {
    out.content = [...out.content, { type: "text", text: CONTACT_NOTICE }];
  }
  return out as T;
}
