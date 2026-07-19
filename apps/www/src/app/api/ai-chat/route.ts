import { convertToModelMessages, createUIMessageStreamResponse, streamText, toUIMessageStream, type UIMessage } from "ai";
import { model } from "@/lib/ai-provider";

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

export async function POST(req: Request) {
  if (!process.env.DOUBLEWORD_API_KEY) {
    return new Response(
      JSON.stringify({ error: "LLM gateway not configured. Set DOUBLEWORD_API_URL and DOUBLEWORD_API_KEY." }),
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
  const result = streamText({
    model,
    system,
    messages: modelMessages,
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({ stream: result.stream }),
  });
}
