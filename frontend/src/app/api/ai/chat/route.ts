import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";

const API_BASE = process.env.LAB_API_BASE_URL || "http://localhost:8000";

function extractText(message: UIMessage | Record<string, any>) {
  if (typeof (message as any).content === "string") return (message as any).content;
  const parts = Array.isArray((message as any).parts) ? (message as any).parts : [];
  return parts
    .map((part: any) => {
      if (part?.type === "text") return part.text || "";
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
}

function toBackendMessages(messages: UIMessage[]) {
  return messages
    .map((message) => ({
      role: message.role,
      content: extractText(message),
    }))
    .filter((message) => message.content && ["system", "user", "assistant"].includes(message.role));
}

function textStream(content: string) {
  return createUIMessageStream({
    execute({ writer }) {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: content });
      writer.write({ type: "text-end", id });
    },
  });
}

async function callFastAPI(messages: { role: string; content: string }[], brokerPhone: string = "") {
  const fastapi = await fetch(`${API_BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, broker_phone: brokerPhone }),
  });

  const raw = await fastapi.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw);
  } catch {
    json = {};
  }

  if (!fastapi.ok || json.error) {
    const errorText = (json.message as string) || (json.error as string) || fastapi.statusText;
    throw new Error(errorText);
  }

  const content = String(json.content || "").trim() || "I could not find an answer for that yet.";
  return { content, blocks: json.blocks || [], sources: json.sources || [], status_steps: json.status_steps || [], trace: json.trace };
}

export async function POST(req: Request) {
  const body = await req.json();
  const messages = toBackendMessages((body.messages || []) as UIMessage[]);
  const brokerPhone = (body.broker_phone as string) || "";

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return createUIMessageStreamResponse({
      stream: textStream("Type a question and I will search your PropAI workspace."),
    });
  }

  try {
    const result = await callFastAPI(messages, brokerPhone);
    return createUIMessageStreamResponse({ stream: textStream(result.content) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat API failed";
    return createUIMessageStreamResponse({ stream: textStream(message) });
  }
}

// Non-streaming endpoint for InboxAIChat (expects ChatResponse JSON)
export async function PUT(req: Request) {
  const body = await req.json();
  const messages = (body.messages || []) as { role: string; content: string }[];
  const brokerPhone = (body.broker_phone as string) || "";

  try {
    const filtered = messages.filter((m) => m.content && ["system", "user", "assistant"].includes(m.role));
    const result = await callFastAPI(filtered, brokerPhone);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat API failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
