/**
 * Shared display helpers for WhatsApp JIDs, phone numbers, and sender names.
 * Used across all frontend pages to avoid leaking raw WhatsApp internal IDs.
 */

const RAW_JID_RE = /@(?:g\.us|s\.whatsapp\.net|lid)$/;
const RAW_JID_WITH_DIGITS_RE = /^\d{12,}[-\d]*@/;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/gu;
const VARIATION_SELECTOR_RE = /\uFE0F/gu;
const ZWJ_RE = /\u200D/gu;

export function stripDecorativeEmoji(value?: string): string {
  const text = (value || "").trim();
  if (!text) return "";
  return text
    .replace(EMOJI_RE, "")
    .replace(VARIATION_SELECTOR_RE, "")
    .replace(ZWJ_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isRawWhatsAppId(value?: string): boolean {
  const text = value || "";
  return RAW_JID_RE.test(text) || RAW_JID_WITH_DIGITS_RE.test(text);
}

/**
 * Extract 10-digit Indian phone number from a JID or raw phone string.
 * Returns empty string if not a valid Indian number.
 */
export function normalizePhone(value?: string): string {
  const raw = (value || "").replace(/\D/g, "");
  if (!raw) return "";
  if (raw.length === 10 && /^[6-9]\d{9}$/.test(raw)) return raw;
  if (raw.length === 12 && raw.startsWith("91") && /^[6-9]\d{9}$/.test(raw.slice(-10)))
    return raw.slice(-10);
  if (raw.length === 11 && raw.startsWith("0") && /^[6-9]\d{9}$/.test(raw.slice(-10)))
    return raw.slice(-10);
  return "";
}

/**
 * Format a phone number for display: +91 XXXXX XXXXX
 */
export function displayPhone(phone?: string): string {
  const local = normalizePhone(phone);
  if (!local) return "";
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

/**
 * Extract phone digits from a JID string.
 */
export function phoneFromJid(jid?: string): string {
  if (!jid) return "";
  if (jid.includes("@lid")) return "";
  const head = jid.split("@")[0] || "";
  return normalizePhone(head);
}

/**
 * Convert a raw group JID like "919820056180-1234567890@g.us" into a display name.
 * If the value is already a human-readable name, returns it unchanged.
 * Uses an optional groups lookup array for resolved names.
 */
export function displayGroupName(
  value?: string,
  knownGroups?: Array<{ jid?: string; name?: string }>,
): string {
  const text = (value || "").trim();
  if (!text || text === "seed" || text === "seed-bot") return "";

  // Try known groups lookup
  if (knownGroups) {
    const match = knownGroups.find((g) => g?.jid === text);
    if (match?.name) return stripDecorativeEmoji(match.name);
  }

  // If it's a raw JID, format a readable fallback
  if (isRawWhatsAppId(text)) {
    if (text.endsWith("@g.us")) {
      const raw = text.split("@")[0];
      const suffix = raw.includes("-") ? raw.split("-").pop()?.slice(-4) : raw.slice(-4);
      return suffix ? `WhatsApp Group ${suffix}` : "WhatsApp Group";
    }
    // DM JID — format as phone
    const phone = phoneFromJid(text);
    return phone ? displayPhone(phone) : "Direct Message";
  }

  return stripDecorativeEmoji(text);
}

/**
 * Resolve the display name for a message sender.
 * Checks broker_name, sender field, and falls back to phone formatting.
 */
export function resolveSenderName(msg: {
  sender?: string;
  broker_name?: string;
  sender_phone?: string;
  sender_jid?: string;
  from_me?: boolean | number;
}): string {
  if (msg.from_me === 1 || msg.from_me === true) return "You";
  const sender = (msg.sender || "").trim();
  const cleanedBrokerName = stripDecorativeEmoji(msg.broker_name || "");
  const cleanedSender = stripDecorativeEmoji(sender);
  if (sender && sender.toLowerCase() !== "unknown" && !isRawWhatsAppId(sender)) {
    return cleanedBrokerName || cleanedSender || sender;
  }
  const phone =
    normalizePhone(msg.sender_phone) || phoneFromJid(msg.sender_jid) || "";
  return cleanedBrokerName || cleanedSender || (phone ? displayPhone(phone) : "Unknown");
}

/**
 * Clean a group name for display — strips @g.us suffixes and raw JID patterns.
 */
export function cleanGroupName(value?: string): string {
  const text = (value || "").trim();
  if (!text) return "";
  if (isRawWhatsAppId(text)) return displayGroupName(text);
  return stripDecorativeEmoji(text);
}
