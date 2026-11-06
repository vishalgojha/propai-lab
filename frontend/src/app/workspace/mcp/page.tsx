"use client";

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Server } from "lucide-react";
import { fetchJSON } from "@/lib/api";

const MCP_ENDPOINT = "https://mcp.propai.live/mcp";

export default function McpWorkspacePage() {
  const [copied, setCopied] = useState(false);
  const [externalToken, setExternalToken] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [dmConsent, setDmConsent] = useState(false);
  const [dmConsentBusy, setDmConsentBusy] = useState(false);

  useEffect(() => {
    void fetchJSON<{ enabled: boolean }>("/external/v1/dm-consent")
      .then((result) => setDmConsent(Boolean(result.enabled)))
      .catch(() => setKeyMessage("Could not load private DM consent status."));
  }, []);

  async function copyEndpoint() {
    await navigator.clipboard.writeText(MCP_ENDPOINT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function createExternalToken() {
    setKeyBusy(true);
    setKeyMessage("");
    try {
      const result = await fetchJSON<{ token: string }>("/external/v1/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Instinct" }) });
      setExternalToken(result.token);
      setKeyMessage("Copy this once, then save it in Instinct Vault. PropAI will not show it again.");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not create the token.");
    } finally {
      setKeyBusy(false);
    }
  }

  async function updateDmConsent(enabled: boolean) {
    setDmConsentBusy(true);
    setKeyMessage("");
    try {
      const result = await fetchJSON<{ enabled: boolean }>("/external/v1/dm-consent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setDmConsent(Boolean(result.enabled));
      setKeyMessage(enabled
        ? "Private DM access is enabled for your external agent tokens."
        : "Private DM access is disabled and removed from active external agent tokens.");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not update private DM consent.");
    } finally {
      setDmConsentBusy(false);
    }
  }

  return (
    <section id="how-to-connect" className="mx-auto max-w-4xl px-4 pb-12 lg:px-6">
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

      <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-amber-200"><KeyRound className="h-5 w-5" aria-hidden="true" /></div>
          <div><h2 className="text-lg font-semibold text-white">Connect an external agent</h2><p className="mt-1 text-sm leading-6 text-zinc-400">Create a tenant-scoped read-only REST token for Instinct or another assistant. Never paste it into WhatsApp chat.</p></div>
        </div>
        <div className="mt-5 grid gap-3 text-sm text-zinc-300 sm:grid-cols-3"><div><div className="font-semibold text-white">Base URL</div><code className="mt-1 block text-xs text-amber-200">https://api.propai.live</code></div><div><div className="font-semibold text-white">Inventory</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/listings/search</code></div><div><div className="font-semibold text-white">Matches</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/matches</code></div></div>
        <button type="button" onClick={() => void createExternalToken()} disabled={keyBusy} className="mt-5 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-60">{keyBusy ? "Creating…" : "Create Instinct token"}</button>
        <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-white">Allow private DM access</div>
              <p className="mt-1 max-w-xl text-xs leading-5 text-zinc-400">Off by default. When enabled, external agents can read private WhatsApp DMs in this workspace in addition to selected group evidence. This never makes DMs public or visible to another tenant.</p>
            </div>
            <button type="button" role="switch" aria-checked={dmConsent} onClick={() => void updateDmConsent(!dmConsent)} disabled={dmConsentBusy} className={`relative h-6 w-11 shrink-0 rounded-full transition ${dmConsent ? "bg-emerald-400" : "bg-zinc-700"}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white transition ${dmConsent ? "left-6" : "left-1"}`} /></button>
          </div>
          <div className="mt-2 text-[11px] font-medium uppercase tracking-[0.12em] text-zinc-500">{dmConsent ? "Enabled for active external tokens" : "Disabled — groups only"}</div>
        </div>
        {externalToken && <div className="mt-4 rounded-xl border border-amber-300/20 bg-black/20 p-4"><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">One-time token</div><code className="mt-2 block break-all text-xs text-amber-100">{externalToken}</code><button type="button" onClick={() => void navigator.clipboard.writeText(externalToken)} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200"><Copy className="h-3.5 w-3.5" /> Copy token</button></div>}
        {keyMessage && <p className="mt-3 text-xs leading-5 text-zinc-400">{keyMessage}</p>}
      </div>
    </section>
  );
}
