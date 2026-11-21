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
  const [redirectUrl, setRedirectUrl] = useState("");
  const [accountEmail, setAccountEmail] = useState("");

  const cleanCode = useMemo(() => userCode.trim().toUpperCase(), [userCode]);
  // Raw search sign-in (state carries the rawflow. marker): limited access, described accurately.
  const isRawFlow = (oauthParams.state || "").startsWith("rawflow.");
  // Return address comes from the MCP server's own pending record, never from this page's query string.
  // Valid only when the server confirmed THIS marker with the raw scope; nothing else can enable approval.
  const [pending, setPending] = useState<{ marker: string; host: string; scope: string } | null>(null);
  const [pendingFailed, setPendingFailed] = useState(false);
  useEffect(() => {
    const marker = oauthParams.state || "";
    setPending(null);
    setPendingFailed(false);
    if (!marker.startsWith("rawflow.")) return;
    let cancelled = false; // a late answer for an earlier marker must not authorize a later one
    const base = new URL(MCP_AUTHORIZE_URL).origin;
    fetch(`${base}/raw-oauth/pending?state=${encodeURIComponent(marker)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("pending"))))
      .then((d) => { if (!cancelled) setPending({ marker, host: String(d.redirect_host || ""), scope: String(d.scope || "") }); })
      .catch(() => { if (!cancelled) setPendingFailed(true); });
    return () => { cancelled = true; };
  }, [oauthParams.state]);
  const pendingOk = Boolean(pending && pending.marker === (oauthParams.state || "") && pending.host && pending.scope === "raw:read");
  const returnHost = pendingOk ? pending!.host : "";
  const mixedRawParams = isRawFlow && Boolean(cleanCode); // a device code cannot be combined with a raw sign-in

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
      setAccountEmail(session.user?.email || "");
      setRefreshToken(session.refresh_token || null);
      setStatus(code || hasOAuthParams ? "ready" : "error");
      setMessage(code || hasOAuthParams ? "" : "Missing MCP authorization details. Start the connection again from Claude or ChatGPT.");
    });
  }, []);

  async function authorize() {
    if (!accessToken || (!cleanCode && !oauthParams.client_id)) return;
    if (isRawFlow && (!pendingOk || mixedRawParams)) return; // never approve without the server-confirmed details

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
          user_code: isRawFlow ? undefined : cleanCode || undefined,
          refresh_token: refreshToken || undefined,
          ...oauthParams,
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.error_description || payload?.error;
        throw new Error(detail || `Unable to authorize this MCP client. (${response.status})`);
      }

      setStatus("success");
      const nextUrl = payload?.redirect_url ? String(payload.redirect_url) : "";
      setRedirectUrl(nextUrl);
      setMessage(nextUrl ? "PropAI MCP is connected." : "PropAI MCP is connected. You can return to Claude or ChatGPT.");
      if (nextUrl) {
        // Hand the authorization code back to the MCP client immediately.
        // Waiting in this page leaves the client callback pending and can
        // make Chromium appear stuck on "Waiting for claude.ai…".
        window.location.replace(nextUrl);
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
          <img
            src="/propai-logo.svg"
            alt="PropAI"
            className="h-12 w-12 rounded-xl border border-emerald-400/20"
          />
          <div>
            <div className="text-lg font-bold">PropAI</div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Broker OS</div>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold">{isRawFlow ? "Authorize raw message search" : "Authorize MCP Access"}</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {isRawFlow
              ? "Connect an AI app to search original WhatsApp group messages from the groups selected for your organization in PropAI."
              : "Connect Claude, ChatGPT, or another MCP client to your PropAI workspace."}
          </p>
        </div>

        <div className="mb-6 rounded-xl border border-white/10 bg-zinc-900/70 p-5">
          <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            <KeyRound className="h-4 w-4" />
            Authorization
          </div>
          <div className="text-sm leading-6 text-zinc-200">
            {cleanCode && !isRawFlow ? (
              <span className="break-all font-mono text-2xl font-black tracking-[0.14em] text-white">{cleanCode}</span>
            ) : isRawFlow && mixedRawParams ? (
              "This sign-in link mixes two different sign-in types and cannot be approved. Start again from your app."
            ) : isRawFlow ? (
              <ul className="list-disc space-y-1 pl-5 text-zinc-200">
                <li>You are signed in to PropAI as {accountEmail || "this account"}. Your PropAI login is checked when this access is granted and is not given to the AI app; your organization membership is checked again on later requests. The app can read messages of the organization linked to this account, including groups that other members of it selected.</li>
                <li>Only WhatsApp groups selected for this organization in PropAI (active, not opted out). No private chats.</li>
                <li>Search, open a message and its surrounding messages. Phone numbers are shown only when the AI app asks for one specific message's contact. These requests are recorded in PropAI's activity log when possible.</li>
                <li>The app gets a separate limited token for this search only: it lasts 1 hour and renews automatically while the app keeps using it. You can be asked to sign in again at any time, including after server restarts.</li>
                <li>PropAI has not verified who this app is. {pendingFailed ? "This sign-in request is unknown or expired; start again from your app." : returnHost ? `Its return address is ${returnHost}.` : "Checking the return address with PropAI..."} Continue only if you started this connection yourself.</li>
              </ul>
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
            <div>{message}</div>
            {redirectUrl ? (
              <div className="mt-3 rounded-lg border border-emerald-400/20 bg-black/20 p-3 text-emerald-100">
                Redirecting back to Claude or ChatGPT in{" "}
                <span className="font-mono text-base font-black text-white">now</span>.
                <a
                  href={redirectUrl}
                  onClick={(event) => {
                    event.preventDefault();
                    window.location.replace(redirectUrl);
                  }}
                  className="mt-2 block text-xs font-bold text-emerald-300 underline underline-offset-4 hover:text-emerald-200"
                >
                  Return now
                </a>
              </div>
            ) : null}
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

        {isRawFlow && (status === "ready" || status === "authorizing") && (
          <p className="mb-3 rounded-lg border border-white/10 bg-black/20 p-3 text-left text-xs leading-5 text-zinc-400">
            Approving this new connection also turns on shared-pool property cross-search read for it: read-only search of groups other brokers explicitly shared. It never shares your own groups, adds DMs, or enables writes. Manage it anytime under Integrations.
          </p>
        )}
        {(status === "ready" || status === "authorizing") && (
          <button
            onClick={authorize}
            disabled={status === "authorizing" || (!cleanCode && !oauthParams.client_id) || (isRawFlow && (!pendingOk || mixedRawParams))}
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
                {isRawFlow ? "Allow raw message search" : "Authorize MCP Client"}
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
