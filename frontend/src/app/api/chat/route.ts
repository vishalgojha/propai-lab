import { streamText } from "ai";
import { model } from "@/lib/ai-provider";

export const runtime = "edge";

const SYSTEM_PROMPT = `You are PropAI, a real estate market intelligence assistant. You help brokers analyze listings, requirements, and market data.

Guidelines:
- Be concise and direct — brokers are busy
- When asked about data you don't have, say so clearly
- Use natural, varied language — don't repeat the same phrasing
- If the user asks something outside real estate, politely redirect
- Support your claims with numbers and specifics when possible`;

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({
    model,
    system: SYSTEM_PROMPT,
    messages,
  });
  return result.toDataStreamResponse();
}
