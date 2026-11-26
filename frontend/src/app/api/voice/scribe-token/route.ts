import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "edge";

// The built-in PropAI voice assistant was retired on 26 November 2026 (owner
// decision: paid provider cost; use Instinct or MCP instead). This route keeps
// its authentication and then returns a retired notice. It never calls
// ElevenLabs: no single-use scribe token is minted for anyone.
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  try {
    const { data, error } = await getSupabaseAdmin().auth.getUser(token);
    if (error || !data.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  } catch {
    return NextResponse.json({ error: "Authentication is temporarily unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    { error: "PropAI's built-in voice assistant has been retired. Use Instinct or MCP instead." },
    { status: 410 },
  );
}
