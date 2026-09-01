import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  try {
    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (error || !data.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

    const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
    if (!apiKey) return NextResponse.json({ error: "Realtime transcription is not configured" }, { status: 503 });

    const response = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
    });
    if (!response.ok) {
      return NextResponse.json({ error: "Realtime transcription is temporarily unavailable" }, { status: 502 });
    }
    const body = await response.json() as { token?: string };
    if (!body.token) return NextResponse.json({ error: "Realtime transcription token was not returned" }, { status: 502 });
    return NextResponse.json({ token: body.token }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Realtime transcription is temporarily unavailable" }, { status: 503 });
  }
}
