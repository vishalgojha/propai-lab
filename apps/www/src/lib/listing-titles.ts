import { getServerSupabase } from "./supabase";

/**
 * Listings don't store their own title — the real, regex/LLM-derived title
 * (e.g. "Rent · 3BHK Sea View, Fully Furnished") is computed once at
 * ingestion time and stored on parsed_output.summary_title, keyed by the
 * raw WhatsApp message it came from. We look it up via
 * listings.representative_raw_message_id (falling back to
 * latest_raw_message_id) instead of re-deriving a title from scratch here.
 */

const EMOJI_RE =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{2B00}-\u{2BFF}]/gu;

export function cleanTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(EMOJI_RE, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 3 ? cleaned : null;
}

/**
 * Batch-fetch summary_title for a set of raw_message ids. Returns a map of
 * raw_message_id -> best summary_title (lowest listing_index wins when a
 * single WhatsApp message contained multiple listings).
 */
export async function getTitlesForRawMessageIds(
  rawMessageIds: Array<number | null | undefined>,
): Promise<Map<number, string>> {
  const ids = Array.from(new Set(rawMessageIds.filter((id): id is number => typeof id === "number")));
  const out = new Map<number, string>();
  const db = getServerSupabase();
  if (!db || ids.length === 0) return out;

  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const { data, error } = await db
      .from("parsed_output")
      .select("raw_message_id, summary_title, listing_index")
      .in("raw_message_id", batch)
      .not("summary_title", "is", null)
      .order("listing_index", { ascending: true });
    if (error) {
      console.error("getTitlesForRawMessageIds error:", error.message);
      continue;
    }
    for (const row of (data ?? []) as Array<{
      raw_message_id: number;
      summary_title: string | null;
      listing_index: number | null;
    }>) {
      if (out.has(row.raw_message_id)) continue;
      const title = cleanTitle(row.summary_title);
      if (title) out.set(row.raw_message_id, title);
    }
  }
  return out;
}
