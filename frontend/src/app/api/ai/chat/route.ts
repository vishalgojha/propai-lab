const API_BASE = process.env.LAB_API_BASE_URL || "http://localhost:8000";

export async function POST(req: Request) {
  const body = await req.json();
  const { messages } = body;

  const fastapi = await fetch(`${API_BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: messages.slice() }),
  });

  const raw = await fastapi.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw);
  } catch {
    json = {};
  }

  const messageId = crypto.randomUUID();

  if (!fastapi.ok || json.error) {
    const errorText = (json.message as string) || (json.error as string) || fastapi.statusText;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "text-start", id: messageId })}\n\n`)
        );
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "text-delta", id: messageId, delta: errorText })}\n\n`)
        );
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "text-end", id: messageId })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "x-vercel-ai-ui-message-stream": "v1",
        "X-Accel-Buffering": "no",
      },
    });
  }

  const content = (json.content as string) || "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "text-start", id: messageId })}\n\n`)
      );
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "text-delta", id: messageId, delta: content })}\n\n`)
      );
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "text-end", id: messageId })}\n\n`)
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "x-vercel-ai-ui-message-stream": "v1",
      "X-Accel-Buffering": "no",
    },
  });
}
