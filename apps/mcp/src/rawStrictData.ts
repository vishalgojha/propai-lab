import { supabase } from "./supabase.js";
import { HIDDEN, redactText } from "./contactPrivacy.ts";

/** Label-grade masking: the standard redaction plus any run of 7+ digits (national-format numbers of any country). */
export const maskForLabel = (t: string) => redactText(t).split(HIDDEN).join("(number)").replace(/\+?\d(?:[\s().-]?\d){6,}/g, "(number)");
import { normalizeRawMessageContextInput, normalizeRawMessageSearchInput, searchRawMessages, searchRawMessagesSemantic, type RawMessageContextItem, type RawMessageSearchInput, type RawMessageSearchResult } from "./data.ts";

/**
 * Contact identity of one captured group message, for the per-option reveal. Group messages of this
 * tenant only; a DM, missing or other-tenant id reads as absent. Needs no extracted listing row.
 */
export async function getRawMessageContact(input: { tenantId: string; rawMessageId: number }) {
  if (!input.tenantId) throw new Error("Tenant scope is required for contact lookup");
  const { data, error } = await supabase
    .from("raw_messages")
    .select("id,sender,sender_phone,sender_jid,message,group_name,is_group,participant:raw_payload->data->key->>participant")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.rawMessageId)
    .eq("is_group", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (!(await filterSelectedIds(input.tenantId, [input.rawMessageId])).has(Number(input.rawMessageId))) return null;
  const row = data as Record<string, any>;
  const fromJid = (v: unknown) => (typeof v === "string" && /@(s\.whatsapp\.net|c\.us)$/.test(v) ? v.split("@")[0].replace(/\D/g, "") : "");
  const sender = String(row.sender_phone || "").replace(/\D/g, "") || fromJid(row.participant) || fromJid(row.sender_jid);
  const text = String(row.message || "");
  const found: Array<{ n: string; label: string }> = [];
  const SENTINEL = "\u0001";
  for (const m of text.matchAll(/(?<![\d.,])(?:\+?91[\s.-]?|0)?[6-9]\d{4}[\s.-]?\d{5}(?!\d)/g)) {
    const n = m[0].replace(/\D/g, "").slice(-10);
    if (found.some((f) => f.n === n)) continue;
    const at = m.index ?? 0;
    // Label is built from the fully redacted source: this candidate becomes a sentinel, then EVERY other number
    // of any country or format is redacted, and only then is the window sliced. No digits can survive into a label.
    const red = maskForLabel(text.slice(0, at) + SENTINEL + text.slice(at + m[0].length)).replace(/\s+/g, " ");
    const k = red.indexOf(SENTINEL);
    const label = `${red.slice(Math.max(0, k - 50), k)}(this number)${red.slice(k + 1, k + 26)}`.replace(SENTINEL, "").trim();
    found.push({ n, label });
  }
  const inText = found.map((f) => f.n);
  const labels = found.map((f) => f.label);
  return { raw_message_id: Number(row.id), sender_name: row.sender ? maskForLabel(String(row.sender)) : null, group_name: row.group_name ? maskForLabel(String(row.group_name)) : null, sender_number: /^91[6-9]\d{9}$/.test(sender) ? sender.slice(2) : /^[6-9]\d{9}$/.test(sender) ? sender : null, numbers_in_message: inText, number_labels: labels };
}


const GET_COLUMNS = "id, group_name, sender, message, message_type, timestamp, source, is_group, processed, chat_jid:raw_payload->data->key->>remoteJid";

/** One group message of this tenant. A DM, missing or other-tenant id reads as absent. */
export async function getGroupRawMessageById(input: { tenantId: string; rawMessageId: number }) {
  if (!input.tenantId) throw new Error("Tenant scope is required for raw message lookup");
  const { data, error } = await supabase.from("raw_messages").select(GET_COLUMNS).eq("tenant_id", input.tenantId).eq("id", input.rawMessageId).eq("is_group", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  if (!(await filterSelectedIds(input.tenantId, [input.rawMessageId])).has(Number(input.rawMessageId))) return null;
  const row = data as unknown as RawMessageSearchResult & { chat_jid?: string | null };
  return { ...row, chat_jid: row.chat_jid || row.group_name };
}

/** Context window around a group message. The anchor is proven to be a group message before the neighbor RPC runs, and every returned item must be a group message. */
export async function getGroupRawMessageContext(input: { tenantId: string; rawMessageId: number; before?: number; after?: number }) {
  const normalized = normalizeRawMessageContextInput(input);
  const { data: anchor, error: anchorError } = await supabase.from("raw_messages").select("id").eq("tenant_id", normalized.tenantId).eq("id", normalized.rawMessageId).eq("is_group", true).maybeSingle();
  if (anchorError) throw new Error(anchorError.message);
  if (!anchor) return { ...normalized, items: [] as RawMessageContextItem[] };
  if (!(await filterSelectedIds(normalized.tenantId, [normalized.rawMessageId])).has(normalized.rawMessageId)) return { ...normalized, items: [] as RawMessageContextItem[] };
  const { data, error } = await supabase.rpc("get_raw_message_context", { p_tenant_id: normalized.tenantId, p_raw_message_id: normalized.rawMessageId, p_before: normalized.before, p_after: normalized.after });
  if (error) throw new Error(error.message);
  const groupItems = ((data || []) as RawMessageContextItem[]).filter((item) => item.is_group === true);
  const okIds = await filterSelectedIds(normalized.tenantId, groupItems.map((i) => Number(i.id)));
  return { ...normalized, items: groupItems.filter((item) => okIds.has(Number(item.id))) };
}


/**
 * Group-selection control. The org's own selection (organization_group_connections) is the positive policy the
 * extraction worker already applies: is_active = true AND opted_out = false. Raw history of every other group is retained
 * in raw_messages, so this route must apply the same policy itself: a group with no row, an inactive row or an opted-out
 * row is not served, on any raw tool.
 */
export async function selectedGroupJids(tenantId: string): Promise<Set<string>> {
  if (!tenantId) throw new Error("Tenant scope is required for group selection");
  const { data, error } = await supabase
    .from("organization_group_connections")
    .select("group_jid, is_active, opted_out")
    .eq("organization_id", tenantId)
    .eq("is_active", true)
    .eq("opted_out", false);
  if (error) throw new Error(error.message);
  return new Set(((data || []) as Array<{ group_jid?: string | null; is_active?: boolean; opted_out?: boolean }>)
    .filter((r) => r.is_active === true && r.opted_out === false && r.group_jid)
    .map((r) => String(r.group_jid)));
}

const JID_COLUMNS = "id, group_name, message_uid, jid_a:raw_payload->data->key->>remoteJid, jid_b:raw_payload->key->>remoteJid";

/** Same chat-id derivation as get_raw_message_context, restricted to group chat ids. */
export function chatJidOf(r: Record<string, any>): string | null {
  const uidPart = String(r.message_uid || "").split(":")[1] || "";
  const candidates = [r.jid_a, r.jid_b, uidPart, String(r.group_name || "").endsWith("@g.us") ? r.group_name : ""];
  const first = candidates.map((v) => String(v || "").trim()).find(Boolean);
  return first && first.endsWith("@g.us") ? first : null;
}

/** Subset of these tenant message ids whose group is selected. Missing, foreign-tenant or unresolvable ids are dropped. */
export async function filterSelectedIds(tenantId: string, ids: number[]): Promise<Set<number>> {
  const unique = [...new Set(ids.filter((n) => Number.isSafeInteger(n)))];
  if (!unique.length) return new Set();
  const selected = await selectedGroupJids(tenantId);
  if (!selected.size) return new Set();
  const ok = new Set<number>();
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await supabase.from("raw_messages").select(JID_COLUMNS).eq("tenant_id", tenantId).eq("is_group", true).in("id", unique.slice(i, i + 100));
    if (error) throw new Error(error.message);
    for (const row of (data || []) as Array<Record<string, any>>) {
      const jid = chatJidOf(row);
      if (jid && selected.has(jid)) ok.add(Number(row.id));
    }
  }
  return ok;
}

type SearchFn = typeof searchRawMessages;

/**
 * Keyword or semantic search over selected groups only. Pages through the shared search (up to MAX_SCAN_PAGES of 100
 * raw hits) and keeps selected-group rows. When the scan budget ends before enough selected rows are found, the result
 * says so (scan_limited) and next_cursor resumes AFTER the last scanned hit, so a caller can always advance.
 */
export const MAX_SCAN_PAGES = 8;
export async function searchSelectedGroups(input: RawMessageSearchInput, mode: "keyword" | "semantic") {
  const normalized = normalizeRawMessageSearchInput({ ...input, scope: "groups" });
  const fn: SearchFn = mode === "semantic" ? (searchRawMessagesSemantic as unknown as SearchFn) : searchRawMessages;
  const kept: Array<{ item: RawMessageSearchResult; next: number }> = [];
  let offset = normalized.offset;
  let more = false;
  let pages = 0;
  while (pages < MAX_SCAN_PAGES && kept.length <= normalized.limit) {
    pages++;
    const res = await fn({ ...input, scope: "groups", limit: 100, offset, cursor: undefined });
    const items = (res.items || []) as RawMessageSearchResult[];
    const ok = await filterSelectedIds(normalized.tenantId, items.map((i) => Number(i.id)));
    // position just after each hit, so a cursor can resume exactly after the last returned row
    items.forEach((item, idx) => { if (item.is_group === true && ok.has(Number(item.id))) kept.push({ item, next: offset + idx + 1 }); });
    more = Boolean(res.has_more);
    const cursor = res.next_cursor && /^\d+$/.test(String(res.next_cursor)) ? Number(res.next_cursor) : NaN;
    const advanced = Number.isFinite(cursor) && cursor > offset ? cursor : offset + items.length;
    if (more && advanced <= offset) { more = false; break; } // cannot advance: do not loop or claim more
    offset = advanced;
    if (!more) break;
  }
  const out = kept.slice(0, normalized.limit);
  const overflow = kept.length > normalized.limit;
  const hasMore = overflow || more;
  const scanLimited = more && !overflow;
  const resume = overflow ? out[out.length - 1].next : offset;
  return { ...normalized, items: out.map((k) => k.item), has_more: hasMore, scan_limited: scanLimited, next_cursor: hasMore ? String(resume) : null };
}
