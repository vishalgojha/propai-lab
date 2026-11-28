"use client";

import { useEffect, useState } from "react";
import { Bot, Check, Copy, ExternalLink, KeyRound, Play, Server } from "lucide-react";
import Link from "next/link";
import { INSTINCT_WHATSAPP_URL } from "@/lib/instinctHandoff";
import ContactSourceConsent from "@/components/ContactSourceConsent";
import { fetchJSON } from "@/lib/api";

const MCP_ENDPOINT = "https://mcp.propai.live/raw-mcp";
const INSTINCT_WORKSPACE_URL = INSTINCT_WHATSAPP_URL;

type AgentStatus = {
  browser?: { ok?: boolean; error?: string; version?: string };
  instinct?: { configured?: boolean };
  mcp?: { configured?: boolean; oauth?: boolean };
};

type ExternalAgentKey = {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  expires_at?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string;
};

type ExternalWriteApproval = {
  id: string;
  entity_type: string;
  sensitive_fields: string[];
  payload?: Record<string, unknown>;
  requested_at: string;
};

export default function McpWorkspacePage() {
  const [copied, setCopied] = useState(false);
  const [externalToken, setExternalToken] = useState<string | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState("");
  const [writeAccess, setWriteAccess] = useState(true);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState(false);
  const [externalKeys, setExternalKeys] = useState<ExternalAgentKey[]>([]);
  const [keyScopeBusy, setKeyScopeBusy] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ExternalWriteApproval[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState("");

  useEffect(() => {
    void fetchJSON<{ keys: ExternalAgentKey[] }>("/external/v1/keys")
      .then((result) => setExternalKeys(result.keys || []))
      .catch(() => { setKeysError(true); setKeyMessage("Could not load existing external API key permissions."); })
      .finally(() => setKeysLoading(false));
    void fetchJSON<{ approvals: ExternalWriteApproval[] }>("/external/v1/approvals")
      .then((result) => setApprovals(result.approvals || []))
      .catch(() => setKeyMessage("Could not load pending CRM approvals."));
    void fetchJSON<AgentStatus>("/integrations/agent/status")
      .then(setAgentStatus)
      .catch(() => setAgentMessage("The setup agent status is temporarily unavailable."));
  }, []);

  async function copyEndpoint() {
    await navigator.clipboard.writeText(MCP_ENDPOINT);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  async function runAgentTask(task: "instinct" | "claude" | "gemini" | "verify", createToken = false) {
    // Open Instinct from the user's click, before the async request yields, so
    // popup blockers do not treat the handoff as an unsolicited window.
    if (task === "instinct") window.open(INSTINCT_WORKSPACE_URL, "_blank", "noopener,noreferrer");
    setAgentBusy(task);
    setAgentMessage("");
    try {
      const result = await fetchJSON<{
        status: string;
        handoff?: string;
        instinct_token?: string;
        browser?: { status?: string; summary?: string; error?: string };
      }>("/integrations/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, create_instinct_token: createToken, launch_browser_check: true }),
      }, 15000);
      if (result.instinct_token) setExternalToken(result.instinct_token);
      setAgentMessage(result.instinct_token
        ? "PropAI is ready and Instinct is open. Save the one-time token in Instinct Vault as PROPAI_API_KEY, then ask Instinct to use PropAI's REST API."
        : result.browser?.error || result.browser?.message || result.handoff || result.browser?.summary || "The integration task is ready.");
      const refreshed = await fetchJSON<AgentStatus>("/integrations/agent/status", undefined, 15000);
      setAgentStatus(refreshed);
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : "The setup agent could not complete this task.");
    } finally {
      setAgentBusy(null);
    }
  }

  async function createExternalToken() {
    setKeyBusy(true);
    setKeyMessage("");
    try {
      const result = await fetchJSON<{ token: string }>("/external/v1/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "Instinct", write_access: writeAccess }) });
      setExternalToken(result.token);
      void fetchJSON<{ keys: ExternalAgentKey[] }>("/external/v1/keys")
        .then((refreshedKeys) => setExternalKeys(refreshedKeys.keys || []))
        .catch(() => setKeyMessage("Token created, but the key list could not refresh."));
      setKeyMessage(writeAccess
        ? "This PropAI connection can create private CRM inventory and requirements for this workspace. Save its one-time secret in Instinct Vault."
        : "Save this one-time PropAI connection secret in Instinct Vault. PropAI will not show it again.");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not create the token.");
    } finally {
      setKeyBusy(false);
    }
  }

  async function updateKeyWriteAccess(key: ExternalAgentKey, enabled: boolean) {
    setKeyScopeBusy(key.id);
    setKeyMessage("");
    try {
      const result = await fetchJSON<{ scopes: string[] }>(`/external/v1/keys/${encodeURIComponent(key.id)}/write-access`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      setExternalKeys((current) => current.map((item) => item.id === key.id ? { ...item, scopes: result.scopes } : item));
      setKeyMessage(enabled
        ? `Private CRM writes enabled for ${key.label} (${key.key_prefix}). The PropAI connection is unchanged; group evidence remains the only raw-message source.`
        : `Private CRM writes removed from ${key.label} (${key.key_prefix}).`);
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not update this API key's permissions.");
    } finally {
      setKeyScopeBusy(null);
    }
  }

  async function updateKeyPhotoAccess(key: ExternalAgentKey, enabled: boolean) {
    setKeyScopeBusy(key.id);
    setKeyMessage("");
    try {
      const result = await fetchJSON<{ scopes: string[] }>(`/external/v1/keys/${encodeURIComponent(key.id)}/photo-access`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }),
      });
      setExternalKeys(current => current.map(item => item.id === key.id ? { ...item, scopes: result.scopes } : item));
      setKeyMessage(enabled ? "Private photo attachment enabled. No inventory creation, other writes or publishing permissions were added." : "Private photo attachment disabled.");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not change photo permission.");
    } finally { setKeyScopeBusy(null); }
  }

  async function rotateKey(key: ExternalAgentKey) {
    setKeyScopeBusy(key.id);
    setKeyMessage("");
    try {
      const result = await fetchJSON<{ token: string }>(`/external/v1/keys/${encodeURIComponent(key.id)}/rotate`, { method: "POST" });
      setExternalToken(result.token);
      setKeyMessage(`Token rotated for ${key.label}. The old token is revoked; save this replacement in Instinct Vault.`);
      const refreshed = await fetchJSON<{ keys: ExternalAgentKey[] }>("/external/v1/keys");
      setExternalKeys(refreshed.keys || []);
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not rotate this API key.");
    } finally {
      setKeyScopeBusy(null);
    }
  }

  async function decideApproval(approvalId: string, approved: boolean) {
    try {
      await fetchJSON(`/external/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved }),
      });
      setApprovals((current) => current.filter((item) => item.id !== approvalId));
      setKeyMessage(approved ? "Approved. The CRM write has been applied." : "Approval rejected; no CRM record was changed.");
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not decide this approval.");
    }
  }

  return (
    <><section id="how-to-connect" className="mx-auto max-w-4xl px-4 pb-12 lg:px-6">
      <div className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3 text-emerald-300">
            <Server className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-white">Connect your assistant</h2>
            <p className="mt-1 text-sm leading-6 text-zinc-400">
              Instinct is the easiest option for brokers: approve PropAI once and start asking for listings. Claude can connect through the broker connector below.
            </p>
            <Link href="/workspace/instinct" className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-black hover:bg-emerald-200" style={{ color: "#052e24" }}>
              Open the Instinct setup page <Bot className="h-4 w-4" aria-hidden="true" />
            </Link>
            <p className="mt-2 text-xs leading-5 text-zinc-500">Step-by-step instructions, WhatsApp pairing, and a copy-ready connect message.</p>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-white/10 bg-black/20 p-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Claude connector</div>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all text-sm text-emerald-200">{MCP_ENDPOINT}</code>
            <button type="button" onClick={() => void copyEndpoint()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-400/30 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-400/10">
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              {copied ? "Copied" : "Copy URL"}
            </button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm text-zinc-300 sm:grid-cols-3">
          <div><div className="font-semibold text-white">1. Copy the URL</div><div className="mt-1 text-xs leading-5 text-zinc-500">Use the button above.</div></div>
          <div><div className="font-semibold text-white">2. Add it to Claude</div><div className="mt-1 text-xs leading-5 text-zinc-500">Settings → Connectors → Add custom connector.</div></div>
          <div><div className="font-semibold text-white">3. Sign in and ask</div><div className="mt-1 text-xs leading-5 text-zinc-500">Approve PropAI, then ask Claude to search your groups.</div></div>
        </div>

        <a href={MCP_ENDPOINT} target="_blank" rel="noreferrer" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-emerald-300 hover:text-emerald-200">
          Check broker connector endpoint <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      </div>

      <details className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <summary className="cursor-pointer list-none text-base font-semibold text-zinc-300">Advanced: API keys, CRM write access, and approvals</summary>
        <div className="mt-5 rounded-2xl border border-amber-300/20 bg-amber-300/[0.05] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-amber-200"><KeyRound className="h-5 w-5" aria-hidden="true" /></div>
          <div><h2 className="text-lg font-semibold text-white">Connect an external agent</h2><p className="mt-1 text-sm leading-6 text-zinc-400">Create a tenant-scoped REST token for Instinct or another assistant. Keep it read-only, or explicitly allow private CRM writes. Never paste it into WhatsApp chat. A token is the manual route; your PropAI email and password are not an API key and do not work as one.</p></div>
        </div>
        <p className="mt-4 text-xs leading-5 text-zinc-500">Connecting Instinct? The <Link href="/workspace/instinct" className="font-semibold text-amber-200 underline underline-offset-2">Instinct tab</Link> has the approval-link setup: normal PropAI sign-in plus Approve, no API key to create or copy.</p>
        <div className="mt-5 grid gap-3 text-sm text-zinc-300 sm:grid-cols-3"><div><div className="font-semibold text-white">Base URL</div><code className="mt-1 block text-xs text-amber-200">https://api.propai.live</code></div><div><div className="font-semibold text-white">Inventory</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/listings/search</code></div><div><div className="font-semibold text-white">Matches</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/matches</code></div></div>
        <p className="mt-4 text-xs leading-5 text-zinc-400">Manual setup only: save the one-time token in Instinct Vault as a password/secret named <code className="text-amber-200">PROPAI_API_KEY</code>. Use endpoint <code className="text-amber-200">https://api.propai.live/api/external/v1</code> and send it as <code className="text-amber-200">X-API-Key</code> or <code className="text-amber-200">Authorization: Bearer</code>.</p>
        <label className="mt-5 flex max-w-xl items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-zinc-300">
          <input type="checkbox" checked={writeAccess} onChange={(event) => setWriteAccess(event.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-300" />
          <span><span className="font-semibold text-white">Allow private CRM writes on the new token</span><span className="mt-1 block leading-5 text-zinc-500">New token only: this option resets when you leave this page. To change a saved key, use its controls below. Instinct may create workspace-private listings and buyer requirements. It cannot publish, delete, send WhatsApp messages, activate ads, or change ad budgets.</span></span>
        </label>
        <button type="button" onClick={() => void createExternalToken()} disabled={keyBusy} className="mt-5 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-60">{keyBusy ? "Creating…" : "Create PropAI connection"}</button>
        <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
          <h3 className="text-sm font-semibold text-white">Existing PropAI connections</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Enable private CRM writes on the current connection without rotating its secret. Private messages are not ingested or available.</p>
          <div className="mt-3 space-y-2">
            {externalKeys.filter((key) => !key.revoked_at).map((key) => {
              const hasWriteAccess = key.scopes.includes("inventory:write") && key.scopes.includes("requirements:write");
              return <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white">{key.label}</div>
                  <code className="mt-1 block text-[11px] text-zinc-500">{key.key_prefix}</code>
                  <div className="mt-1 text-[11px] text-zinc-400">{hasWriteAccess ? "Private CRM writes enabled" : "Read only"} · Group evidence only</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void updateKeyWriteAccess(key, !hasWriteAccess)} disabled={keyScopeBusy === key.id} className="inline-flex min-h-9 items-center rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-60">{keyScopeBusy === key.id ? "Updating…" : hasWriteAccess ? "Remove write access" : "Enable private CRM writes"}</button>
                  <button type="button" onClick={() => void updateKeyPhotoAccess(key, !key.scopes.includes("photos:write"))} disabled={keyScopeBusy === key.id} className="inline-flex min-h-9 items-center rounded-lg border border-emerald-300/30 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-300/10 disabled:opacity-60">{key.scopes.includes("photos:write") ? "Disable private photos" : "Enable private photos only"}</button>
                  <button type="button" onClick={() => void rotateKey(key)} disabled={keyScopeBusy === key.id} className="inline-flex min-h-9 items-center rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-60">Rotate token</button>
                </div>
              </div>;
            })}
            {keysLoading && <p role="status" className="text-xs text-zinc-400">Loading existing key permissions...</p>}
            {keysError && <p role="alert" className="text-xs text-amber-200">Key permissions could not be loaded. This does not mean you have no keys. Refresh to try again; do not create a replacement token.</p>}
            {!keysLoading && !keysError && !externalKeys.some((key) => !key.revoked_at) && <p className="rounded-lg border border-white/10 px-3 py-4 text-xs text-zinc-500">No active external API keys found. Create a key above.</p>}
          </div>
        </div>
        {approvals.length > 0 && <div className="mt-5 rounded-xl border border-red-300/20 bg-red-300/[0.04] p-4">
          <h3 className="text-sm font-semibold text-white">Sensitive CRM approvals</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-400">These changes are paused until you approve them. Review the request in Instinct or your CRM context before allowing it.</p>
          <div className="mt-3 space-y-2">{approvals.map((approval) => <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-3"><div><div className="text-xs font-semibold text-white">{approval.entity_type}</div><div className="mt-1 text-[11px] text-zinc-400">Sensitive: {approval.sensitive_fields.join(", ")}</div><code className="mt-1 block max-w-xl break-all text-[11px] text-zinc-500">{JSON.stringify(approval.payload || {})}</code></div><div className="flex gap-2"><button type="button" onClick={() => void decideApproval(approval.id, false)} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300">Reject</button><button type="button" onClick={() => void decideApproval(approval.id, true)} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black">Approve</button></div></div>)}</div>
        </div>}
        <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-sm font-semibold text-white">Private message boundary</div><p className="mt-1 text-xs leading-5 text-zinc-400">Private WhatsApp messages are not ingested, stored, searchable, or available to external agents. PropAI connections use selected group evidence and tenant-private CRM records only.</p></div>
        {externalToken && <div className="mt-4 rounded-xl border border-amber-300/20 bg-black/20 p-4"><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">One-time PropAI connection secret</div><code className="mt-2 block break-all text-xs text-amber-100">{externalToken}</code><button type="button" onClick={() => void navigator.clipboard.writeText(externalToken)} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200"><Copy className="h-3.5 w-3.5" /> Copy secret</button></div>}
        {keyMessage && <p className="mt-3 text-xs leading-5 text-zinc-400">{keyMessage}</p>}
        </div>
      </details>

      <details className="mt-5 rounded-2xl border border-white/10 bg-white/[0.02] p-6">
        <summary className="cursor-pointer list-none text-base font-semibold text-zinc-300">Other assistants and technical checks</summary>
        <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-cyan-300/25 bg-cyan-300/10 p-3 text-cyan-200"><Bot className="h-5 w-5" aria-hidden="true" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-white">Connect your assistant</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">Connect PropAI to the assistant you already use. Each card shows where to add PropAI in that assistant, plus a PropAI-side verification.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[
            {
              task: "instinct",
              label: "Connect Instinct",
              steps: "Ask Instinct to connect to PropAI, then open the secure link it sends. Sign in, review the access, and approve. Instinct saves the connection automatically; no credentials to copy.",
              site: null,
              siteLabel: null,
              shots: null,
            },
            {
              task: "claude",
              label: "Connect Claude",
              steps: "In Claude: Settings > Connectors > + > Add custom connector, then paste the PropAI MCP URL from above.",
              site: "https://claude.ai/",
              siteLabel: "Open Claude",
              shots: [
                ["/setup/claude-1-settings.jpg", "1. Settings > Connectors"],
                ["/setup/claude-2-add-menu.jpg", "2. + > Add custom connector"],
                ["/setup/claude-3-form.jpg", "3. Name + MCP server URL"],
              ],
            },
            {
              task: "gemini",
              label: "Connect Gemini",
              steps: "Currently US-only, age 18+, personal Google Account, English and History on. If eligible, use Gemini on the web: Settings > Connected Apps > Custom apps > Add a custom app, then paste the MCP URL above. If this option is missing in India, use Claude or Instinct instead.",
              site: "https://gemini.google.com/",
              siteLabel: "Open Gemini",
              shots: null,
            },
            {
              task: "verify",
              label: "Re-run PropAI checks",
              steps: "Verify the PropAI endpoints and browser runtime after connecting.",
              site: null,
              siteLabel: null,
              shots: null,
            },
          ].map(({ task, label, steps, site, siteLabel, shots }) => (
            <div key={task} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="font-semibold text-white">{label}</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{steps}</p>
              {shots && (
                <div className="mt-3 grid gap-3 sm:grid-cols-3">
                  {shots.map(([src, caption]) => (
                    <figure key={src} className="overflow-hidden rounded-lg border border-white/10">
                      <a href={src} target="_blank" rel="noreferrer" aria-label={`${caption}. Open full-size screenshot`}>
                        <img src={src} alt={caption} className="h-auto w-full" loading="lazy" />
                      </a>
                      <figcaption className="px-1.5 py-1 text-[10px] leading-3 text-zinc-500">{caption}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {task === "instinct" && <a href="/workspace/instinct" className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/10">Open Instinct setup</a>}
                {site && <a href={site} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/10">{siteLabel}</a>}
                {site && <button type="button" onClick={() => void copyEndpoint()} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/[0.06]"><Copy className="h-3.5 w-3.5" /> {copied ? "Copied" : "Copy MCP URL"}</button>}
                <button type="button" onClick={() => void runAgentTask(task === "instinct" ? "verify" : task as "claude" | "gemini" | "verify")} disabled={agentBusy === task} aria-busy={agentBusy === task} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-400 hover:bg-white/[0.06] disabled:opacity-60">
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />{agentBusy === task ? "Running…" : "Verify PropAI side"}
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-[11px] uppercase tracking-[0.12em] text-zinc-500">
          <span>Instinct {agentStatus?.instinct?.configured ? "ready" : "not configured"}</span>
          <span>MCP {agentStatus?.mcp?.configured ? "available" : "unavailable"}</span>
          <span>Browser {agentStatus?.browser?.ok ? "ready" : "needs deployment"}</span>
        </div>
        {agentMessage && <p className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3 text-xs leading-5 text-zinc-300">{agentMessage}</p>}
        </div>
      </details>
    </section><div className="mx-auto max-w-4xl px-4 pb-8"><ContactSourceConsent /></div></>
  );
}
