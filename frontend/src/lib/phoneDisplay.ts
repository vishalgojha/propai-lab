/** Display-only phone formatting. Never changes what is stored or sent. */
export function digitsOnly(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D+/g, "");
}

function groupIndian(national10: string): string {
  return `${national10.slice(0, 5)} ${national10.slice(5)}`;
}

/** 91 + 10 digits shows as "+91 XXXXX XXXXX"; anything else is returned as typed. */
export function formatPhoneWithCountry(value: string | null | undefined): string {
  const digits = digitsOnly(value);
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${groupIndian(digits.slice(2))}`;
  return String(value ?? "").trim();
}

/**
 * Signup-typed numbers carry no country field. Show 91+10 with its country,
 * and label every other shape without guessing a country or repairing digits.
 */
export function describeSignupPhone(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  const digits = digitsOnly(raw);
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${groupIndian(digits.slice(2))}`;
  if (digits.length === 10) return `${raw} (10 digits, no country code entered)`;
  return `${raw} (${digits.length} digits, format not recognised)`;
}

/**
 * Suggested broker senders come from group-member numbers that PropAI stores
 * as the 10-digit national number (the 91 prefix is removed when sampled).
 * Show them in the same +91 form as the selected senders. Display only: the
 * stored value and the value sent when selecting are unchanged.
 */
export function formatSuggestedSender(stored: string): string {
  const digits = digitsOnly(stored);
  if (digits.length === 10) return `+91 ${groupIndian(digits)}`;
  return formatPhoneWithCountry(stored) || `+${digits}`;
}

/** Same sender regardless of a leading 91 (display matching only). */
export function sameSenderIdentity(a: string, b: string): boolean {
  const x = digitsOnly(a), y = digitsOnly(b);
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}
