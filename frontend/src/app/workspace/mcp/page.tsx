"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Server } from "lucide-react";

const MCP_ENDPOINT = "https://mcp.propai.live/mcp";

export default function McpWorkspacePage() {
  const [copied, setCopied] = useState(false);

  async function copyEndpoint() {
    await navigator.clipboard.writeText(MCP_ENDPOINT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <section className="mx-auto max-w-4xl px-4 pb-12 lg:px-6">
      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-emerald-300">
            <Server className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-white">Connect PropAI MCP</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              Connect Claude or another MCP client to this authenticated workspace. MCP reads remain tenant-scoped; it cannot see another brokerage&apos;s inventory.
            </p>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">MCP server URL</div>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all text-sm text-emerald-200">{MCP_ENDPOINT}</code>
            <button type="button" onClick={() => void copyEndpoint()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/30 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-400/10">
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {copied ? "Copied" : "Copy URL"}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm text-zinc-300 sm:grid-cols-3">
          <div><div className="font-semibold text-white">1. Add URL</div><div className="mt-1 text-xs leading-5 text-zinc-500">Paste the server URL into Claude&apos;s Settings → Connectors.</div></div>
          <div><div className="font-semibold text-white">2. Sign in</div><div className="mt-1 text-xs leading-5 text-zinc-500">Approve the OAuth request with your PropAI account.</div></div>
          <div><div className="font-semibold text-white">3. Ask Claude</div><div className="mt-1 text-xs leading-5 text-zinc-500">Search your captured WhatsApp groups, inventory, and CRM.</div></div>
        </div>

        <a href="https://mcp.propai.live/" target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200">
          View MCP server details <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
