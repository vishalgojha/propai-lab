import { providers } from "./ai-provider";
import { canonicalLocality } from "./locality-canon";

/**
 * AI-assisted locality extraction from a natural-language property query.
 * Uses the first available LLM provider via direct HTTP (avoids SDK type issues).
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

  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`${provider.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 30,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) continue;

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) continue;

      const result = text.replace(/^["']|["']$/g, "");
      if (!result || result.toUpperCase() === "NONE") return null;

      const match = knownLocalities.find(
        (l) => l.locality.toLowerCase() === result.toLowerCase(),
      );
      if (match) return match.locality;

      const canonical = canonicalLocality(result);
      if (canonical.label) {
        const canonicalMatch = knownLocalities.find(
          (l) => l.locality.toLowerCase() === canonical.label.toLowerCase(),
        );
        if (canonicalMatch) return canonicalMatch.locality;
      }

      return null;
    } catch {
      continue;
    }
  }

  return null;
}
