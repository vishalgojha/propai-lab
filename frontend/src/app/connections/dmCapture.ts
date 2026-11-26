/**
 * Opt-in broker direct-message capture: pure helpers for the connections UI.
 *
 * Approved scope: property messages from broker contacts the user explicitly
 * selects one by one, searchable only in their own account, never shared with
 * other brokers. The server gates capture twice (designated sender, then a
 * property-listing content check) and records the consent version; these
 * helpers only build truthful plans and copy for that flow.
 */

export const DM_CAPTURE_CONSENT_VERSION = "broker-dm-capture-v1";

export type DMSenderRow = {
  sender_phone: string;
  display_name: string;
  confirmed_at?: string;
  revoked_at?: string;
};

export type DMCaptureState = {
  available: boolean;
  consentVersion: string;
  consentText: string;
  /** Active designated senders. */
  active: DMSenderRow[];
  /** Revoked designations (metadata only, so a stop is visible). */
  revoked: DMSenderRow[];
  /** Broker phones seen in the workspace's captured groups, not yet designated. */
  suggested: string[];
};

export const EMPTY_DM_CAPTURE: DMCaptureState = {
  available: false,
  consentVersion: "",
  consentText: "",
  active: [],
  revoked: [],
  suggested: [],
};

/**
 * Bare 10-15 digit phone identity for a direct-message sender, or "".
 * Mirrors the API's normalize_dm_sender_phone: punctuation and spaces are
 * ignored, country/trunk digits are never guessed.
 */
export function normalizeDMSenderPhone(value: string): string {
  // Device/agent-suffixed user JIDs ("9198...:12", "9198....0:12"): the
  // suffix is not part of the phone identity.
  const base = String(value || "").split("@")[0].split(":")[0].split(".")[0];
  const digits = base.replace(/[^0-9]/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

/**
 * Merge a typed phone into the checked set, normalizing first. Returns the
 * next checked set plus the rejected raw value ("" when accepted), so the UI
 * can flag an unusable number instead of silently dropping it.
 */
export function addTypedSender(checked: Set<string>, raw: string): { checked: Set<string>; rejected: string } {
  const phone = normalizeDMSenderPhone(raw);
  if (!phone) return { checked, rejected: String(raw || "").trim() };
  const next = new Set(checked);
  next.add(phone);
  return { checked: next, rejected: "" };
}

/**
 * The enable payload: checked phones that are not already active, each with
 * an optional display label. Already-active phones are never re-sent.
 */
export function buildEnablePayload(checked: Set<string>, active: DMSenderRow[], nameByPhone: Record<string, string>): { phone: string; name?: string }[] {
  const activePhones = new Set(active.map((row) => row.sender_phone));
  return Array.from(checked)
    .filter((phone) => !activePhones.has(phone))
    .sort()
    .map((phone) => {
      const name = String(nameByPhone[phone] || "").trim();
      return name ? { phone, name } : { phone };
    });
}

export type DMCaptureOutcomeInput = {
  /** Phones this operation tried to enable. */
  attemptedEnable: string[];
  /** Phones this operation tried to revoke. */
  attemptedRevoke: string[];
  /** Active phones before this operation. */
  beforeActive: Set<string>;
  /** Active phones after the operation, verified from the server. */
  afterActive: Set<string>;
};

/**
 * Truthful post-confirmation summary computed from the server's refreshed
 * state, never from the attempted set. Counts reconcile against the attempt
 * and the scope limits are restated each time.
 */
export function buildDMCaptureOutcomeMessage(input: DMCaptureOutcomeInput): string {
  const { attemptedEnable, attemptedRevoke, beforeActive, afterActive } = input;
  const newlyEnabled = attemptedEnable.filter((phone) => !beforeActive.has(phone) && afterActive.has(phone)).length;
  const removed = attemptedRevoke.filter((phone) => beforeActive.has(phone) && !afterActive.has(phone)).length;
  const total = afterActive.size;
  const parts: string[] = [];
  if (newlyEnabled > 0) {
    parts.push(
      `Now capturing property messages from ${newlyEnabled} sender${newlyEnabled === 1 ? "" : "s"}.`
    );
  }
  if (removed > 0) {
    parts.push(
      `Stopped capturing from ${removed} sender${removed === 1 ? "" : "s"}.`
    );
  }
  if (newlyEnabled === 0 && removed === 0) {
    parts.push("Nothing changed: the covered senders were already in this state.");
  }
  if (total > 0) {
    parts.push(
      `Capturing from ${total} sender${total === 1 ? "" : "s"} in total: only messages that look like property listings are saved, searchable only in your account, never shared with other brokers.`
    );
  } else {
    parts.push("No senders selected: direct messages stay private and are never saved.");
  }
  return parts.join(" ");
}
