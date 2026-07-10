import { streamText } from "ai";
import { model } from "@/lib/ai-provider";

export const runtime = "edge";

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = streamText({ model, messages });
  return result.toDataStreamResponse();
}
