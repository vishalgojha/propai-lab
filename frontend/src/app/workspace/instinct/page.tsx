"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, KeyRound } from "lucide-react";

const INSTINCT_PROMPT = `Use my PropAI integration.

At the start of every new instance, fetch and read the public API guide:
https://api.propai.live/api/external/v1/docs
Follow its authentication, permission, privacy, and evidence rules throughout this conversation.

Retrieve the API secret from Instinct Vault using the exact secret name:
PROPAI_API_KEY

Never ask me to paste or reveal the secret. Never display it in your response.

PropAI API base URL:
https://api.propai.live/api/external/v1

Authenticate every request using:
X-API-Key: <value from PROPAI_API_KEY>

Available endpoints:
- Read integration instructions: GET /docs (public; read this first for every new instance)
- Search inventory: GET /listings/search
- Search WhatsApp messages: GET /messages/search?scope=groups|dms&q=<query>&limit=25
- Fetch a matching WhatsApp message: GET /messages/{raw_message_id}
- Find matches: GET /matches

When I ask about private WhatsApp conversations, search with scope=dms only. This scope is available only when the PropAI workspace owner has enabled private-DM access. If the API denies access, tell me that access is disabled and do not retry with scope=all. Use scope=groups only when I ask about group messages. Never broaden a DM search to groups or all chats.

Treat WhatsApp messages as private, unverified source evidence, not confirmed inventory. Keep all data within my PropAI workspace. When I ask for properties, use the API instead of guessing or fabricating data. Show relevant source details returned by the API, distinguish private messages from group messages, and clearly say when no matching records are found.`;

export default function InstinctWorkspacePage() {
  const [copied, setCopied] = useState(false);

  async function copyPrompt() {
    await navigator.clipboard.writeText(INSTINCT_PROMPT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <main className="mx-auto max-w-4xl px-4 pb-12 pt-8 lg:px-6">
      <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-amber-200">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-200/70">Instinct connection</p>
            <h2 className="mt-1 text-xl font-semibold text-white">Connect Instinct to PropAI</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Save the PropAI key in Instinct Vault, then send the prompt below to Instinct on WhatsApp. The prompt tells Instinct how to authenticate without exposing your key.</p>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-xs font-semibold text-white">Vault secret</div><code className="mt-2 block text-sm text-amber-200">PROPAI_API_KEY</code></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4 sm:col-span-2"><div className="text-xs font-semibold text-white">API base URL</div><code className="mt-2 block break-all text-xs text-amber-200">https://api.propai.live/api/external/v1</code></div>
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Copy this prompt to Instinct WhatsApp</h3>
            <p className="mt-1 text-xs text-zinc-500">Do not paste the actual API key into WhatsApp.</p>
          </div>
          <button type="button" onClick={() => void copyPrompt()} className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10">
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </div>
        <pre className="mt-3 max-h-[34rem] overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-4 text-xs leading-6 text-zinc-300">{INSTINCT_PROMPT}</pre>

        <a href="https://app.instinct.com/workspace" target="_blank" rel="noreferrer" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-amber-200 hover:text-amber-100">
          Open Instinct workspace <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </main>
  );
}
