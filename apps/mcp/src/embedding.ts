import { supabase } from "./supabase.ts";

const EMBED_MODEL = process.env.EMBEDDING_MODEL || process.env.DOUBLEWORD_EMBEDDING_MODEL || "nvidia/nemotron-3-embed-1b:free";
const EMBED_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS || process.env.DOUBLEWORD_EMBEDDING_DIMENSIONS || "1024");
const EMBED_TIMEOUT_MS = 8000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const EMBEDDING_BASE_URL = (process.env.EMBEDDING_BASE_URL || process.env.DOUBLEWORD_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
let rateLimitedUntil = 0;

function getEmbeddingApiKeys(): string[] {
  return [process.env.EMBEDDING_API_KEY, process.env.OPENROUTER_API_KEY, process.env.DOUBLEWORD_EMBEDDING_API_KEY, process.env.DOUBLEWORD_API_KEY]
    .filter(Boolean)
    .flatMap((value) => String(value).split(/[\n,;]+/))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function generateEmbedding(text: string, inputType: "search_query" | "search_document" = "search_query"): Promise<number[] | null> {
  const input = String(text || "").trim();
  if (!input) {
    return null;
  }

  const apiKeys = getEmbeddingApiKeys();
  if (!apiKeys.length) {
    console.warn("[mcp/embedding] EMBEDDING_API_KEY or OPENROUTER_API_KEY is not configured");
    return null;
  }
  if (!EMBED_MODEL) {
    console.warn("[mcp/embedding] DOUBLEWORD_EMBEDDING_MODEL is not configured");
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

      const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: EMBED_MODEL,
          input,
          ...(EMBEDDING_BASE_URL.includes("openrouter.ai") && EMBED_MODEL.startsWith("nvidia/")
            ? {}
            : { dimensions: EMBED_DIMENSIONS }),
          input_type: EMBEDDING_BASE_URL.includes("openrouter.ai")
            ? inputType === "search_query"
              ? "query"
              : inputType === "search_document"
                ? EMBED_MODEL.startsWith("nvidia/")
                  ? "passage"
                  : EMBED_MODEL.startsWith("voyageai/")
                    ? "document"
                    : inputType
                : inputType
            : inputType,
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
      if (embedding.length < EMBED_DIMENSIONS) {
        console.warn(`[mcp/embedding] Expected at least ${EMBED_DIMENSIONS} dimensions, received ${embedding.length}`);
        return null;
      }
      const sliced = embedding.slice(0, EMBED_DIMENSIONS);
      const norm = Math.sqrt(sliced.reduce((sum, value) => sum + value * value, 0));
      return norm > 0 ? sliced.map((value) => value / norm) : null;
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

export type SemanticResult = {
  entity_type: string;
  source_table: string;
  source_id: number;
  tenant_id: string | null;
  similarity: number;
  content: string;
  metadata: Record<string, unknown>;
};

export async function semanticSearch(input: {
  query: string;
  entityTypes?: string[];
  tenantId?: string | null;
  limit?: number;
  minSimilarity?: number;
}): Promise<SemanticResult[]> {
  const embedding = await generateEmbedding(input.query, "search_query");
  if (!embedding) return [];
  const literal = `[${embedding.join(",")}]`;
  const { data, error } = await supabase.rpc("match_semantic_embeddings", {
    p_query_embedding: literal,
    p_entity_types: input.entityTypes || null,
    p_tenant_id: input.tenantId || null,
    p_limit: Math.min(Math.max(input.limit || 20, 1), 100),
    p_min_similarity: input.minSimilarity ?? 0.25,
    p_model: EMBED_MODEL,
  });
  if (error) {
    console.warn(`[mcp/embedding] Semantic search failed: ${error.message}`);
    return [];
  }
  return (data || []) as SemanticResult[];
}
