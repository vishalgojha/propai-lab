import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { getProviderModel, providers, providerCount } from "@/lib/ai-provider";

export const runtime = "edge";

const BASE_SYSTEM = `You are PropAI, a helpful real-estate assistant for home buyers and renters in India.
You help people understand the live property listings we just showed them.

Guidelines:
- Be concise, warm, and direct — the user is house-hunting and in a hurry.
- Answer ONLY from the "Current search results" context provided below. If something is not in the results, say so plainly ("I don't see that in the current results") instead of guessing.
- Use natural, varied language — don't repeat the same phrasing.
- Support claims with specifics from the listings (locality, BHK, price, building).
- Mention the broker contact path only as "message the broker on WhatsApp" — never show phone numbers.
- If asked something outside property search, politely redirect to real estate.
- Keep answers short: a few sentences, or a short bullet list when comparing options.`;

/* ── Health cache: remember last working provider ─────────────────── */
let cachedIndex = -1;
let cacheTs = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function findWorkingProvider(): Promise<number> {
  if (cachedIndex >= 0 && Date.now() - cacheTs < CACHE_TTL) return cachedIndex;

  const results = await Promise.allSettled(
    providers.map(async (cfg, i) => {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => ({ ok: false, status: 0 }));
      if (res.ok) return i;
      throw new Error(`provider ${i} status ${res.status}`);
    }),
  );

  const first = results.find((r) => r.status === "fulfilled") as
    | PromiseFulfilledResult<number>
    | undefined;

  const idx = first?.value ?? -1;
  if (idx >= 0) {
    cachedIndex = idx;
    cacheTs = Date.now();
  }
  return idx;
}

export async function POST(req: Request) {
  if (providerCount === 0) {
    return new Response(
      JSON.stringify({ error: "No LLM providers configured. Set at least one API key." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const body = (await req.json()) as {
    messages?: UIMessage[];
    context?: string;
  };
  const messages = body.messages || [];
  const context = body.context?.trim();

  const system = context
    ? `${BASE_SYSTEM}\n\n--- CURRENT SEARCH RESULTS (the user is looking at these right now) ---\n${context}\n--- END SEARCH RESULTS ---`
    : BASE_SYSTEM;

  const modelMessages = await convertToModelMessages(messages);

  const idx = await findWorkingProvider();
  if (idx < 0) {
    return new Response(
      JSON.stringify({ error: "All LLM providers are currently unavailable." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const p = getProviderModel(idx);
  if (!p) {
    return new Response(
      JSON.stringify({ error: "Provider not found." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const result = streamText({
    model: p.model,
    system,
    messages: modelMessages,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
