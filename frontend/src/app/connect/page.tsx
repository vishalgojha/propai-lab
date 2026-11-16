"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, KeyRound, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { getSession } from "@/lib/auth";
import { fetchJSON } from "@/lib/api";

type ConnectPreview = {
  label: string;
  write_access: boolean;
  scopes: string[];
};

type PageStatus = "checking" | "ready" | "deciding" | "approved" | "denied" | "error";

export default function ConnectAgentPage() {
  const [status, setStatus] = useState<PageStatus>("checking");
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<ConnectPreview | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const next = (params.get("code") || "").trim().toUpperCase();
    setCode(next);
    if (!next) {
      setStatus("error");
      setMessage("Missing connection code. Start the connection again from your assistant.");
      return;
    }
    getSession().then((session) => {
      if (!session?.access_token) {
        window.location.href = `/auth/login?next=${encodeURIComponent(`/connect?code=${next}`)}`;
        return;
      }
      fetchJSON<ConnectPreview>(`/external/v1/connect/sessions/by-code/${encodeURIComponent(next)}`)
        .then((result) => {
          setPreview(result);
          setStatus("ready");
        })
        .catch((error) => {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "This connection link is invalid or has expired.");
        });
    });
  }, []);

  async function decide(approve: boolean) {
    if (!code) return;
    setStatus("deciding");
    try {
      await fetchJSON(`/external/v1/connect/sessions/by-code/${encodeURIComponent(code)}/${approve ? "approve" : "deny"}`, {
        method: "POST",
      });
      setStatus(approve ? "approved" : "denied");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not record your decision. Ask your assistant to start a new connection.");
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
          <h1 className="text-2xl font-bold">Connect an assistant</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {preview?.label
              ? `${preview.label} is asking for access to your PropAI workspace.`
              : "An assistant is asking for access to your PropAI workspace."}
          </p>
        </div>

        {code && (
          <div className="mb-6 rounded-xl border border-white/10 bg-zinc-900/70 p-5">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
              <KeyRound className="h-4 w-4" />
              Connection code
            </div>
            <div className="break-all font-mono text-2xl font-black tracking-[0.14em] text-white">{code}</div>
          </div>
        )}

        {status === "checking" && (
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900 p-4 text-sm text-zinc-300">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            Checking your PropAI session...
          </div>
        )}

        {status === "ready" && preview && (
          <>
            <div className="mb-4 rounded-xl border border-white/10 bg-zinc-900/70 p-4 text-sm leading-6 text-zinc-300">
              <div className="mb-1 font-semibold text-white">Read access</div>
              Listings, requirements, matches, and captured WhatsApp messages in your workspace.
              {preview.write_access && (
                <>
                  <div className="mb-1 mt-3 font-semibold text-white">Private CRM writes</div>
                  This connection can also save inventory, requirements, standing searches, and
                  follow-ups into your private CRM. Anything with contact or budget details still
                  needs your approval in Account → MCP before it is saved.
                </>
              )}
              <div className="mt-3 text-xs text-zinc-500">
                Approving creates a new access key for this assistant. You can revoke it any time
                in Account → MCP.
              </div>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => decide(true)}
                className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-400 px-4 py-3 text-sm font-bold text-black transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ShieldCheck className="h-4 w-4" />
                Approve access
              </button>
              <button
                onClick={() => decide(false)}
                className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-white/15 px-4 py-3 text-sm font-bold text-zinc-200 transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
              >
                Decline
              </button>
            </div>
          </>
        )}

        {status === "deciding" && (
          <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900 p-4 text-sm text-zinc-300">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-400" />
            Recording your decision...
          </div>
        )}

        {status === "approved" && (
          <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-300">
            <div className="mb-1 flex items-center gap-2 font-semibold text-white">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Approved
            </div>
            Your assistant is collecting the connection now and will confirm in your chat when
            it is active. You can close this page. If it does not confirm within a few minutes,
            revoke the new key in Account → MCP.
          </div>
        )}

        {status === "denied" && (
          <div className="rounded-xl border border-white/10 bg-zinc-900 p-4 text-sm text-zinc-300">
            <div className="mb-1 flex items-center gap-2 font-semibold text-white">
              <XCircle className="h-4 w-4 text-zinc-400" />
              Declined
            </div>
            No access was granted. You can close this page.
          </div>
        )}

        {status === "error" && (
          <div className="rounded-xl border border-red-400/20 bg-red-500/10 p-4 text-sm text-red-300">
            <div className="mb-1 flex items-center gap-2 font-semibold text-white">
              <XCircle className="h-4 w-4 text-red-400" />
              Connection failed
            </div>
            {message}
          </div>
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
