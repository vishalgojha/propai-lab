import { supabase } from "./supabase.js";

export async function createSessionRecord(input: {
  sessionId: string;
  userId?: string | null;
  userAgent?: string | null;
}) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("mcp_sessions")
    .upsert({
      session_id: input.sessionId,
      user_id: input.userId || null,
      user_agent: input.userAgent || null,
      transport: "streamable-http",
      status: "active",
      created_at: now,
      last_seen_at: now,
      updated_at: now,
    }, { onConflict: "session_id" });

  if (error) throw new Error(error.message);
}

export async function touchSessionRecord(sessionId: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("mcp_sessions")
    .update({
      last_seen_at: now,
      updated_at: now,
      status: "active",
    })
    .eq("session_id", sessionId);

  if (error) throw new Error(error.message);
}

export async function closeSessionRecord(sessionId: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("mcp_sessions")
    .update({
      status: "closed",
      updated_at: now,
      last_seen_at: now,
    })
    .eq("session_id", sessionId);

  if (error) throw new Error(error.message);
}
