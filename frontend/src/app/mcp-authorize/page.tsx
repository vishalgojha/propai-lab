"use client";

export const dynamic = "force-dynamic";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { getSession } from "@/lib/auth";

type Status = "checking" | "ready" | "authorizing" | "success" | "error";

const MCP_AUTHORIZE_URL =
  process.env.NEXT_PUBLIC_MCP_AUTHORIZE_URL || "https://mcp.propai.live/device/authorize";

export default function McpAuthorizePage() {
  const [status, setStatus] = useState<Status>("checking");
  const [userCode, setUserCode] = useState("");
  const [message, setMessage] = useState("");
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [oauthParams, setOauthParams] = useState<Record<string, string>>({});

  const cleanCode = useMemo(() => userCode.trim().toUpperCase(), [userCode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = (params.get("user_code") || "").trim().toUpperCase();
    const clientId = params.get("client_id") || "";
    const redirectUri = params.get("redirect_uri") || "";
    const codeChallenge = params.get("code_challenge") || "";
    const codeChallengeMethod = params.get("code_challenge_method") || "S256";
    const state = params.get("state") || "";
    const hasOAuthParams = Boolean(clientId && redirectUri && codeChallenge);

    getSession().then((session) => {
      if (!session?.access_token) {
        const next = `/mcp-authorize${window.location.search}`;
        window.location.href = `/auth/login?next=${encodeURIComponent(next)}`;
        return;
      }

      setUserCode(code);
      setOauthParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
      });
      setAccessToken(session.access_token);
      setRefreshToken(session.refresh_token || null);
      setStatus(code || hasOAuthParams ? "ready" : "error");
      setMessage(code || hasOAuthParams ? "" : "Missing MCP authorization details. Start the connection again from Claude or ChatGPT.");
    });
  }, []);

  async function authorize() {
    if (!accessToken || !cleanCode) return;

    setStatus("authorizing");
    setMessage("");

    try {
      const response = await fetch(MCP_AUTHORIZE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_code: cleanCode || undefined,
          refresh_token: refreshToken || undefined,
          ...oauthParams,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || "Unable to authorize this MCP client.");
      }

      setStatus("success");
      setMessage("PropAI MCP is connected. You can return to Claude or ChatGPT.");
      if (payload?.redirect_url) {
        window.location.href = String(payload.redirect_url);
      }
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Unable to authorize this MCP client.");
    }
  }

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-4 py-12">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-950 p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-2xl font-black text-emerald-400">
            +
          </div>
          <div>
            <div className="text-lg font-bold">PropAI</div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Broker OS</div>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold">Authorize MCP Access</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Connect Claude, ChatGPT, or another MCP client to your PropAI workspace.
          </p>
        </div>

        <div className="mb-6 rounded-xl border border-white/10 bg-zinc-900/70 p-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <KeyRound className="h-4 w-4" />
            Authorization
          </div>
          <div className="text-sm leading-6 text-zinc-200">
            {cleanCode ? (
              <span className="break-all font-mono text-2xl font-black tracking-[0.14em] text-white">{cleanCode}</span>
            ) : (
              "This MCP client will get access to your PropAI broker workspace tools."
            )}
          </div>
        </div>

        {status === "checking" && (
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900 p-4 text-sm text-zinc-300">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            Checking your PropAI session...
          </div>
        )}

        {status === "success" && (
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-300">
            <div className="mb-1 flex items-center gap-2 font-semibold text-white">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Connected
            </div>
            {message}
          </div>
        )}

        {status === "error" && (
          <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-300">
            <div className="mb-1 flex items-center gap-2 font-semibold text-white">
              <XCircle className="h-4 w-4 text-red-400" />
              Authorization failed
            </div>
            {message}
          </div>
        )}

        {(status === "ready" || status === "authorizing") && (
          <button
            onClick={authorize}
            disabled={status === "authorizing" || (!cleanCode && !oauthParams.client_id)}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-3 text-sm font-bold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "authorizing" ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Authorizing...
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4" />
                Authorize MCP Client
              </>
            )}
          </button>
        )}

        <div className="mt-6 text-center text-xs text-zinc-500">
          <Link href="/inbox" className="text-emerald-400 hover:text-emerald-300">
            Back to PropAI
          </Link>
        </div>
      </section>
    </main>
  );
}
