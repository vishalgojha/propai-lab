"use client";

import { useEffect, useState } from "react";
import { Bot, Check, Copy, ExternalLink, KeyRound, Play, Server } from "lucide-react";
import { fetchJSON } from "@/lib/api";

const MCP_ENDPOINT = "https://mcp.propai.live/mcp";
const INSTINCT_WORKSPACE_URL = "https://app.instinct.com";

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
  const [writeAccess, setWriteAccess] = useState(false);
  const [externalKeys, setExternalKeys] = useState<ExternalAgentKey[]>([]);
  const [keyScopeBusy, setKeyScopeBusy] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ExternalWriteApproval[]>([]);
  const [dmConsent, setDmConsent] = useState(false);
  const [dmConsentBusy, setDmConsentBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [agentBusy, setAgentBusy] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState("");

  useEffect(() => {
    void fetchJSON<{ keys: ExternalAgentKey[] }>("/external/v1/keys")
      .then((result) => setExternalKeys(result.keys || []))
      .catch(() => setKeyMessage("Could not load existing external API key permissions."));
    void fetchJSON<{ approvals: ExternalWriteApproval[] }>("/external/v1/approvals")
      .then((result) => setApprovals(result.approvals || []))
      .catch(() => setKeyMessage("Could not load pending CRM approvals."));
    void fetchJSON<{ enabled: boolean }>("/external/v1/dm-consent")
      .then((result) => setDmConsent(Boolean(result.enabled)))
      .catch(() => setKeyMessage("Could not load private DM consent status."));
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
        ? "This token can create private CRM inventory and requirements for this workspace. Copy it once, then save it in Instinct Vault."
        : "Copy this once, then save it in Instinct Vault. PropAI will not show it again.");
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
        ? `Private CRM writes enabled for ${key.label} (${key.key_prefix}). The API key itself is unchanged; DM access is unchanged.`
        : `Private CRM writes removed from ${key.label} (${key.key_prefix}).`);
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : "Could not update this API key's permissions.");
    } finally {
      setKeyScopeBusy(null);
    }
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
          <div><h2 className="text-lg font-semibold text-white">Connect an external agent</h2><p className="mt-1 text-sm leading-6 text-zinc-400">Create a tenant-scoped REST token for Instinct or another assistant. Keep it read-only, or explicitly allow private CRM writes. Never paste it into WhatsApp chat.</p></div>
        </div>
        <div className="mt-5 grid gap-3 text-sm text-zinc-300 sm:grid-cols-3"><div><div className="font-semibold text-white">Base URL</div><code className="mt-1 block text-xs text-amber-200">https://api.propai.live</code></div><div><div className="font-semibold text-white">Inventory</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/listings/search</code></div><div><div className="font-semibold text-white">Matches</div><code className="mt-1 block text-xs text-zinc-400">/api/external/v1/matches</code></div></div>
        <p className="mt-4 text-xs leading-5 text-zinc-400">Instinct setup: save the one-time token in Instinct Vault as a password/secret named <code className="text-amber-200">PROPAI_API_KEY</code>. Use endpoint <code className="text-amber-200">https://api.propai.live/api/external/v1</code> and send it as <code className="text-amber-200">X-API-Key</code> or <code className="text-amber-200">Authorization: Bearer</code>.</p>
        <label className="mt-5 flex max-w-xl items-start gap-3 rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-zinc-300">
          <input type="checkbox" checked={writeAccess} onChange={(event) => setWriteAccess(event.target.checked)} className="mt-0.5 h-4 w-4 accent-amber-300" />
          <span><span className="font-semibold text-white">Allow private CRM writes</span><span className="mt-1 block leading-5 text-zinc-500">Instinct may create workspace-private listings and buyer requirements. It cannot publish, delete, send WhatsApp messages, activate ads, or change ad budgets.</span></span>
        </label>
        <button type="button" onClick={() => void createExternalToken()} disabled={keyBusy} className="mt-5 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-60">{keyBusy ? "Creating…" : "Create Instinct token"}</button>
        <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
          <h3 className="text-sm font-semibold text-white">Existing external API keys</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-500">Enable private CRM writes on the current key without rotating its secret. This does not change private DM permission.</p>
          <div className="mt-3 space-y-2">
            {externalKeys.filter((key) => !key.revoked_at).map((key) => {
              const hasWriteAccess = key.scopes.includes("inventory:write") && key.scopes.includes("requirements:write");
              return <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white">{key.label}</div>
                  <code className="mt-1 block text-[11px] text-zinc-500">{key.key_prefix}</code>
                  <div className="mt-1 text-[11px] text-zinc-400">{hasWriteAccess ? "Private CRM writes enabled" : "Read only"} · {key.scopes.includes("raw_messages:dms") ? "DM key scope present; workspace consent still applies" : "No DM key scope"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void updateKeyWriteAccess(key, !hasWriteAccess)} disabled={keyScopeBusy === key.id} className="inline-flex min-h-9 items-center rounded-lg border border-amber-300/30 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-300/10 disabled:opacity-60">{keyScopeBusy === key.id ? "Updating…" : hasWriteAccess ? "Remove write access" : "Enable private CRM writes"}</button>
                  <button type="button" onClick={() => void rotateKey(key)} disabled={keyScopeBusy === key.id} className="inline-flex min-h-9 items-center rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-white/5 disabled:opacity-60">Rotate token</button>
                </div>
              </div>;
            })}
            {!externalKeys.some((key) => !key.revoked_at) && <p className="rounded-lg border border-white/10 px-3 py-4 text-xs text-zinc-500">No active external API keys found. Create a key above.</p>}
          </div>
        </div>
        {approvals.length > 0 && <div className="mt-5 rounded-xl border border-red-300/20 bg-red-300/[0.04] p-4">
          <h3 className="text-sm font-semibold text-white">Sensitive CRM approvals</h3>
          <p className="mt-1 text-xs leading-5 text-zinc-400">These changes are paused until you approve them. Review the request in Instinct or your CRM context before allowing it.</p>
          <div className="mt-3 space-y-2">{approvals.map((approval) => <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-3"><div><div className="text-xs font-semibold text-white">{approval.entity_type}</div><div className="mt-1 text-[11px] text-zinc-400">Sensitive: {approval.sensitive_fields.join(", ")}</div><code className="mt-1 block max-w-xl break-all text-[11px] text-zinc-500">{JSON.stringify(approval.payload || {})}</code></div><div className="flex gap-2"><button type="button" onClick={() => void decideApproval(approval.id, false)} className="rounded-lg border border-white/15 px-3 py-2 text-xs text-zinc-300">Reject</button><button type="button" onClick={() => void decideApproval(approval.id, true)} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black">Approve</button></div></div>)}</div>
        </div>}
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

      <div className="mt-5 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.05] p-6">
        <div className="flex items-start gap-4">
          <div className="rounded-xl border border-cyan-300/25 bg-cyan-300/10 p-3 text-cyan-200"><Bot className="h-5 w-5" aria-hidden="true" /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-white">PropAI setup agent</h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">Run the repetitive PropAI-side checks for Instinct, Claude, and Gemini from one place. The agent records each browser check and stops at third-party login, CAPTCHA, consent, or sending boundaries.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {[
            ["instinct", "Prepare Instinct", "Create a one-time token and verify the REST endpoint."],
            ["claude", "Prepare Claude MCP", "Verify the MCP endpoint and OAuth handoff."],
            ["gemini", "Prepare Gemini MCP", "Verify the MCP endpoint for a Gemini connector."],
            ["verify", "Run all checks", "Check the PropAI endpoints and browser runtime."],
          ].map(([task, label, detail]) => (
            <div key={task} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="font-semibold text-white">{label}</div>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>
              <button type="button" onClick={() => void runAgentTask(task as "instinct" | "claude" | "gemini" | "verify", task === "instinct")} disabled={agentBusy === task} aria-busy={agentBusy === task} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-200 hover:bg-cyan-300/10 disabled:opacity-60">
                <Play className="h-3.5 w-3.5" aria-hidden="true" />{agentBusy === task ? "Running…" : label}
              </button>
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
    </section>
  );
}
