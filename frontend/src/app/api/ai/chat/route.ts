import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

const API_BASE = process.env.LAB_API_BASE_URL || "http://localhost:8000";

type IncomingMessage = {
  role: string;
  content?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

function extractText(message: IncomingMessage): string {
  if (typeof message.content === "string" && message.content) return message.content;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (typeof part?.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
}

function toBackendMessages(messages: IncomingMessage[]) {
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

function sanitizeChatErrorMessage(input: string, fallback: string) {
  const text = String(input || "").trim();
  if (!text) return fallback;
  if (/<!doctype html|<html[\s>]|<body[\s>]|cloudflare|bad gateway|error code 502|error 502/i.test(text)) {
    return fallback;
  }
  return text.length > 240 ? `${text.slice(0, 237).trim()}...` : text;
}

function sseProxyStream(fastapiStream: ReadableStream<Uint8Array>) {
  return createUIMessageStream({
    async execute({ writer }) {
      const decoder = new TextDecoder();
      const reader = fastapiStream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;
            try {
              const chunk = JSON.parse(data);
              writer.write(chunk);
            } catch {
              // skip unparseable lines
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

async function callFastAPI(messages: { role: string; content: string }[], brokerPhone: string = "", sessionId: string = "", authHeader = "", source: string = "", attachments: unknown[] = []) {
  const fastapi = await fetch(`${API_BASE}/api/ai/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify({ messages, broker_phone: brokerPhone, session_id: sessionId, source, attachments }),
  });

  if (!fastapi.ok) {
    let errorText = fastapi.statusText;
    try {
      const json = await fastapi.json();
      errorText = (json.message as string) || (json.error as string) || errorText;
    } catch {}
    throw new Error(sanitizeChatErrorMessage(errorText, "AI search is temporarily unavailable. Please try again."));
  }

  if (!fastapi.body) {
    throw new Error("Empty response from API");
  }

  return fastapi.body;
}

export async function POST(req: Request) {
  const body = await req.json();
  const messages = toBackendMessages((body.messages || []) as IncomingMessage[]);
  const brokerPhone = (body.broker_phone as string) || "";
  const sessionId = (body.session_id as string) || "";
  const authHeader = req.headers.get("authorization") || "";
  const source = (body.source as string) || "";
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return createUIMessageStreamResponse({
      stream: textStream("Type a question and I will search your PropAI workspace."),
    });
  }

  try {
    const fastapiStream = await callFastAPI(messages, brokerPhone, sessionId, authHeader, source, attachments);
    return createUIMessageStreamResponse({ stream: sseProxyStream(fastapiStream) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat API failed";
    return createUIMessageStreamResponse({
      stream: textStream(sanitizeChatErrorMessage(message, "AI search is temporarily unavailable. Please try again.")),
    });
  }
}

// Non-streaming endpoint for InboxAIChat (expects ChatResponse JSON)
export async function PUT(req: Request) {
  const body = await req.json();
  const messages = (body.messages || []) as { role: string; content: string }[];
  const brokerPhone = (body.broker_phone as string) || "";
  const sessionId = (body.session_id as string) || "";
  const authHeader = req.headers.get("authorization") || "";
  const source = (body.source as string) || "";

  try {
    const filtered = messages.filter((m) => m.content && ["system", "user", "assistant"].includes(m.role));
    const fastapi = await fetch(`${API_BASE}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: JSON.stringify({ messages: filtered, broker_phone: brokerPhone, session_id: sessionId, source }),
    });
    if (!fastapi.ok) {
      throw new Error(
        sanitizeChatErrorMessage(
          await fastapi.text(),
          "AI search is temporarily unavailable. Please try again."
        )
      );
    }
    const json = await fastapi.json();
    return Response.json(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chat API failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
