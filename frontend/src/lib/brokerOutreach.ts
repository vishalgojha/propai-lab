/**
 * Manual broker outreach helpers. Nothing here sends a message: it only builds
 * a wa.me link the owner opens and sends himself.
 */
export type OutreachStatus = "sent" | "replied" | "skipped";

export type PhoneResult =
  | { kind: "international"; e164digits: string }
  | { kind: "assumed_india"; e164digits: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "none"; reason: string };

export function digitsOnly(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D+/g, "");
}

/**
 * A number is sendable without a guess only when it carries its own country:
 * a leading "+" or the 91 + 10 shape. A bare 10-digit number stores no country,
 * so it stays ambiguous unless the owner explicitly turns on the India option.
 */
export function resolveBrokerPhone(raw: string | null | undefined, assumeIndiaForBare10: boolean): PhoneResult {
  const text = String(raw ?? "").trim();
  const d = digitsOnly(text);
  if (!d) return { kind: "none", reason: "No number stored" };
  // Indian numbers: exactly 91 + a 10-digit national number starting 6-9.
  if (d.startsWith("91") && (text.startsWith("+") || d.length === 12)) {
    if (d.length === 12 && /^[6-9]/.test(d.slice(2))) return { kind: "international", e164digits: d };
    return { kind: "ambiguous", reason: "starts with 91 but is not a valid Indian mobile number" };
  }
  // Other countries only when the number states its own country with "+" and a plausible E.164 shape.
  if (text.startsWith("+") && /^[1-9]\d{10,14}$/.test(d)) return { kind: "international", e164digits: d };
  if (d.length === 10) {
    if (assumeIndiaForBare10 && /^[6-9]/.test(d)) return { kind: "assumed_india", e164digits: `91${d}` };
    return { kind: "ambiguous", reason: "10 digits, country not stored" };
  }
  return { kind: "ambiguous", reason: `${d.length} digits, format not recognised` };
}

export function buildWaLink(e164digits: string, message: string): string {
  return `https://wa.me/${e164digits}?text=${encodeURIComponent(message)}`;
}

/**
 * Status key from the stored shape only, so marks never change when the India
 * option is toggled. A bare 10-digit number and the same digits written with
 * 91 are different records: no country is assumed to merge them.
 */
export function brokerStatusKey(raw: string | null | undefined): string {
  const d = digitsOnly(raw);
  if (!d) return "";
  return d.length === 10 ? `bare:${d}` : `intl:${d}`;
}

export const OUTREACH_STORE_KEY = "propai.brokerOutreach.v1";

export type OutreachStore = {
  template: string;
  assumeIndia: boolean;
  statuses: Record<string, { status: OutreachStatus; at: string }>; // legacy local field, unused
};

export function parseStore(json: string | null, fallbackTemplate: string): OutreachStore {
  const empty: OutreachStore = { template: fallbackTemplate, assumeIndia: true, statuses: {} };
  if (!json) return empty;
  try {
    const v = JSON.parse(json);
    const statuses: OutreachStore["statuses"] = {};
    for (const [k, s] of Object.entries((v && v.statuses) || {})) {
      const st = s as { status?: string; at?: string };
      if (st && (st.status === "sent" || st.status === "replied" || st.status === "skipped") && typeof st.at === "string") {
        statuses[k] = { status: st.status, at: st.at };
      }
    }
    return {
      template: typeof v.template === "string" && v.template.trim() ? v.template : fallbackTemplate,
      // The owner confirmed "India only": +91 is the default for valid national numbers.
      assumeIndia: v.assumeIndia !== false,
      statuses,
    };
  } catch {
    return empty;
  }
}
