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
  if (text.startsWith("+") && d.length >= 11 && d.length <= 15) return { kind: "international", e164digits: d };
  if (d.length === 12 && d.startsWith("91")) return { kind: "international", e164digits: d };
  if (d.length === 10) {
    if (assumeIndiaForBare10 && /^[6-9]/.test(d)) return { kind: "assumed_india", e164digits: `91${d}` };
    return { kind: "ambiguous", reason: "10 digits, country not stored" };
  }
  return { kind: "ambiguous", reason: `${d.length} digits, format not recognised` };
}

export function buildWaLink(e164digits: string, message: string): string {
  return `https://wa.me/${e164digits}?text=${encodeURIComponent(message)}`;
}

/** Stable key so the same person is one record whatever format the phone came in. */
export function brokerStatusKey(raw: string | null | undefined): string {
  const d = digitsOnly(raw);
  return d.length === 12 && d.startsWith("91") ? d.slice(2) : d;
}

export const OUTREACH_STORE_KEY = "propai.brokerOutreach.v1";

export type OutreachStore = {
  template: string;
  assumeIndia: boolean;
  statuses: Record<string, { status: OutreachStatus; at: string }>;
};

export function parseStore(json: string | null, fallbackTemplate: string): OutreachStore {
  const empty: OutreachStore = { template: fallbackTemplate, assumeIndia: false, statuses: {} };
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
      assumeIndia: v.assumeIndia === true,
      statuses,
    };
  } catch {
    return empty;
  }
}
