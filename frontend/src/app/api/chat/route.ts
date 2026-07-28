export const runtime = "edge";

export async function POST(req: Request) {
  const body = await req.json() as {
    messages?: Array<{ role?: string; content?: string; parts?: Array<{ type?: string; text?: string }> }>;
    session_id?: string;
    broker_phone?: string;
  };
  const messages = (body.messages || []).map((message) => ({
    role: message.role || "user",
    content: message.content || (message.parts || [])
      .filter((part) => part.type === "text")
      .map((part) => part.text || "")
      .join(""),
  }));
  const apiBase = process.env.LAB_API_BASE_URL || "http://localhost:8000";
  const upstream = await fetch(`${apiBase.replace(/\/$/, "")}/api/ai/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(req.headers.get("authorization") ? { Authorization: req.headers.get("authorization")! } : {}),
    },
    body: JSON.stringify({
      messages,
      session_id: body.session_id || "",
      broker_phone: body.broker_phone || "",
      source: "chat",
    }),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("content-type") || "text/event-stream",
      "Cache-Control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
