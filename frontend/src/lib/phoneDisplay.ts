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
 * Suggested broker senders are stored as the number WhatsApp group sampling
 * kept: often a bare 10-digit national number whose country is not stored.
 * A bare 10-digit value is shown as stored with the country marked
 * unspecified. No country code is guessed. Display only.
 */
export function formatSuggestedSender(stored: string): string {
  const digits = digitsOnly(stored);
  if (digits.length === 10) return `${digits} (country not stored)`;
  return formatPhoneWithCountry(stored) || `+${digits}`;
}

/** Exact same stored sender digits only. No cross-country or last-10 equivalence. */
export function sameSenderIdentity(a: string, b: string): boolean {
  const x = digitsOnly(a), y = digitsOnly(b);
  return x.length >= 10 && x === y;
}
