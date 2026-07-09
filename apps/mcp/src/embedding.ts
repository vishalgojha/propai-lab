const EMBED_MODEL = process.env.DOUBLEWORD_EMBEDDING_MODEL || "Qwen/Qwen3-Embedding-8B";
const EMBED_DIMENSIONS = Number(process.env.DOUBLEWORD_EMBEDDING_DIMENSIONS || "768");
const EMBED_TIMEOUT_MS = 8000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const DOUBLEWORD_BASE_URL = (process.env.DOUBLEWORD_BASE_URL || "https://api.doubleword.ai/v1").replace(/\/+$/, "");
let rateLimitedUntil = 0;

function getDoublewordApiKeys(): string[] {
  return [process.env.DOUBLEWORD_EMBEDDING_API_KEY, process.env.DOUBLEWORD_API_KEY]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\n,;]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const input = String(text || "").trim();
  if (!input) {
    return null;
  }

  const apiKeys = getDoublewordApiKeys();
  if (!apiKeys.length) {
    console.warn("[mcp/embedding] DOUBLEWORD_EMBEDDING_API_KEY or DOUBLEWORD_API_KEY is not configured");
    return null;
  }
  if (Date.now() < rateLimitedUntil) {
    console.warn("[mcp/embedding] Doubleword embedding requests are paused after rate limiting");
    return null;
  }

  let sawRateLimit = false;
  for (const apiKey of apiKeys) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

      const response = await fetch(`${DOUBLEWORD_BASE_URL}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input,
          dimensions: EMBED_DIMENSIONS,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.warn(`[mcp/embedding] Doubleword embedding HTTP ${response.status}: ${detail.slice(0, 240)}`);
        if (response.status === 429) {
          sawRateLimit = true;
          continue;
        }
        return null;
      }

      const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
      const embedding = data.data?.[0]?.embedding;
      if (!Array.isArray(embedding) || !embedding.length) {
        console.warn("[mcp/embedding] Empty or missing embedding in response");
        return null;
      }
      if (embedding.length !== EMBED_DIMENSIONS) {
        console.warn(`[mcp/embedding] Expected ${EMBED_DIMENSIONS} dimensions, received ${embedding.length}`);
        return null;
      }

      return embedding;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.warn("[mcp/embedding] Embedding request timed out");
      } else {
        console.warn("[mcp/embedding] Failed to generate embedding:", error);
      }
      return null;
    }
  }
  if (sawRateLimit) rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  return null;
}
