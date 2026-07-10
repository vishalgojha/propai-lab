import { createAgentUIStreamResponse, ToolLoopAgent } from "ai";
import { model } from "@/lib/ai-provider";
import { getOverviewTool } from "@/lib/ai-tools/get-overview";

export const runtime = "edge";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const agent = new ToolLoopAgent({
    model,
    tools: {
      get_overview: getOverviewTool,
    },
    maxSteps: 5,
  });

  return createAgentUIStreamResponse({
    agent,
    messages,
  });
}