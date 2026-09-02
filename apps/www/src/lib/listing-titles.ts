import { getServerSupabase } from "./supabase";

/**
 * Listings store the source-generated title on the typed listing projection.
 * The old parsed_output_unified compatibility view does not expose that
 * column in production, so title lookup must use the live unified projection.
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
      .from("listings_unified_public")
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
