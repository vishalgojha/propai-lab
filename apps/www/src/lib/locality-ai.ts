import { generateText } from "ai";
import { getProviderModel, providers } from "./ai-provider";
import { canonicalLocality } from "./locality-canon";

/**
 * AI-assisted locality extraction from a natural-language property query.
 *
 * Returns the best-matching known locality name (canonical label) or null.
 * Uses the first available LLM provider with a 3-second timeout.
 * Falls back to null on any error so the caller can use regex fallback.
 */
export async function extractLocalityWithAI(
  query: string,
  knownLocalities: Array<{ locality: string; slug: string }>,
): Promise<string | null> {
  if (!query.trim() || providers.length === 0 || knownLocalities.length === 0) {
    return null;
  }

  const localityList = knownLocalities
    .map((l) => l.locality)
    .filter(Boolean)
    .join(", ");

  const prompt = `You are a property search assistant. Extract the SINGLE best-matching locality/area name from the user's search query.

Known localities: ${localityList}

User query: "${query}"

Rules:
- Return ONLY the exact locality name from the known list above (e.g. "Bandra West")
- If the query mentions a bare name like "bandra", map it to the full known form (e.g. "Bandra West")
- If NO locality is mentioned or no match exists, return exactly: NONE
- Do NOT explain. Return ONLY the locality name or NONE.`;

  try {
    const provider = getProviderModel(0);
    if (!provider) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const { text } = await generateText({
      model: provider.model,
      prompt,
      maxOutputTokens: 30,
      abortSignal: controller.signal,
    });

    clearTimeout(timeout);

    const result = text.trim().replace(/^["']|["']$/g, "");
    if (!result || result.toUpperCase() === "NONE") return null;

    // Validate: the result must be one of the known localities.
    const match = knownLocalities.find(
      (l) => l.locality.toLowerCase() === result.toLowerCase(),
    );
    if (match) return match.locality;

    // Try canonical match (e.g. AI returns "bandra" → "Bandra West").
    const canonical = canonicalLocality(result);
    if (canonical.label) {
      const canonicalMatch = knownLocalities.find(
        (l) => l.locality.toLowerCase() === canonical.label.toLowerCase(),
      );
      if (canonicalMatch) return canonicalMatch.locality;
    }

    return null;
  } catch {
    return null;
  }
}
