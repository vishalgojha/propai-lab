"use client";

export const dynamic = "force-dynamic";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { ExternalLink, Copy, Check, Eye, EyeOff } from "lucide-react";
import {
  getCompanionConfig,
  saveCompanionConfig,
  type CompanionConfig,
} from "@/lib/api";

const PROPAI_WABA_NUMBER = "+9170210455254";
const WEBHOOK_CALLBACK_URL = "https://api.propai.live/api/whatsapp/cloud/webhook";

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="text-zinc-500 hover:text-[#3EE88A] transition-colors"
      title="Copy"
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function MaskedValue({ value, label }: { value: string; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <div className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white font-mono break-all flex-1 min-w-0">
        {show ? value : value ? "••••••••••••••••" : "Not configured"}
      </div>
      <button
        onClick={() => setShow(!show)}
        className="text-zinc-500 hover:text-zinc-300 transition-colors"
        title={show ? "Hide" : "Show"}
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
      {value && <CopyButton value={value} />}
    </div>
  );
}

function MetaLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[#3EE88A] hover:underline text-xs"
    >
      {children}
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

export default function WabaPage() {
  const [waba, setWaba] = useState<CompanionConfig | null>(null);
  const [businessNumber, setBusinessNumber] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    getCompanionConfig()
      .then((cfg) => {
        setWaba(cfg);
        if (cfg.outbound_allowed && cfg.whatsapp_business_number && cfg.whatsapp_business_number !== PROPAI_WABA_NUMBER) {
          setBusinessNumber(cfg.whatsapp_business_number.replace(/^\+91/, ""));
          setPhoneNumberId(cfg.phone_number_id || "");
        }
      })
      .catch(() => setWaba(null));
  }, []);

  useEffect(() => {
    if (!waba || editing) return;
    if (waba.outbound_allowed && waba.whatsapp_business_number !== PROPAI_WABA_NUMBER) {
      setBusinessNumber(waba.whatsapp_business_number?.replace(/^\+91/, "") || "");
      setPhoneNumberId(waba.phone_number_id || "");
    }
  }, [waba, editing]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setStatus("");

    const form = new FormData(event.currentTarget);
    const raw = String(form.get("whatsapp_business_number") || "").trim();
    const cleaned = raw.replace(/^\+91/, "");
    const nextBusinessNumber = cleaned ? `+91${cleaned}` : "";
    const nextPhoneNumberId = String(form.get("phone_number_id") || "").trim();
    const nextAccessToken = String(form.get("access_token") || "").trim();
    const nextVerifyToken = String(form.get("verify_token") || "").trim();

    if (`+91${cleaned}` === PROPAI_WABA_NUMBER) {
      setStatus("PropAI shared WABA is reserved for platform messages.");
      setSaving(false);
      return;
    }

    const missing = [
      !cleaned ? "WhatsApp Business Number" : "",
      !nextPhoneNumberId ? "Phone Number ID" : "",
      !nextAccessToken && !waba?.has_access_token ? "Access Token" : "",
      !nextVerifyToken && !waba?.has_verify_token ? "Verify Token" : "",
    ].filter(Boolean);
    if (missing.length) {
      setStatus(`Missing: ${missing.join(", ")}`);
      setSaving(false);
      return;
    }

    try {
      const next = await saveCompanionConfig({
        whatsapp_business_number: nextBusinessNumber || undefined,
        phone_number_id: nextPhoneNumberId || undefined,
        access_token: nextAccessToken || undefined,
        verify_token: nextVerifyToken || undefined,
      });
      setWaba(next);
      setAccessToken("");
      setVerifyToken("");
      setEditing(false);
      const config = await getCompanionConfig().catch(() => null);
      if (config) setWaba(config);
      setStatus("Configuration saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const isConfigured = Boolean(waba?.outbound_allowed);
  const displayPhoneNumberId = waba?.phone_number_id || phoneNumberId;

  return (
    <div className="max-w-3xl mx-auto px-4 lg:px-0 py-8">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">WhatsApp Business API</h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-500">
          Your WABA credentials, webhook URL, and direct links to your Meta dashboard.
        </p>
      </div>

      {/* ── Status Banner ─────────────────────────────────────── */}
      {isConfigured ? (
        <div className="rounded-2xl border border-[#3EE88A]/20 bg-[#3EE88A]/5 p-4 mb-6 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-[#3EE88A] flex-shrink-0" />
          <div className="text-sm text-[#3EE88A] font-semibold">WABA Connected</div>
          <div className="text-xs text-zinc-400 ml-auto">{waba?.whatsapp_business_number}</div>
        </div>
      ) : (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 mb-6 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0" />
          <div className="text-sm text-amber-300 font-semibold">Not configured</div>
          <div className="text-xs text-zinc-500 ml-auto">Add your WABA credentials below</div>
        </div>
      )}

      {/* ── Webhook URL ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/10 mb-4">
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">Webhook Callback URL</h3>
          <CopyButton value={WEBHOOK_CALLBACK_URL} />
        </div>
        <div className="px-5 py-4">
          <div className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white font-mono break-all select-all">
            {WEBHOOK_CALLBACK_URL}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Paste this in Meta App Dashboard →{" "}
            <strong className="text-zinc-400">WhatsApp → Configuration → Webhook → Callback URL</strong>
          </p>
          <MetaLink href="https://developers.facebook.com/apps">
            Open Meta App Dashboard
          </MetaLink>
        </div>
      </div>

      {/* ── Verify Token ──────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/10 mb-4">
        <div className="px-5 py-3 border-b border-white/10">
          <h3 className="text-sm font-bold text-white">Verify Token</h3>
        </div>
        <div className="px-5 py-4">
          <MaskedValue value={waba?.verify_token_preview || ""} label="Verify Token" />
          <p className="mt-2 text-[11px] text-zinc-500">
            Set the same string in Meta App Dashboard →{" "}
            <strong className="text-zinc-400">WhatsApp → Configuration → Webhook → Verify Token</strong>
          </p>
        </div>
      </div>

      {/* ── Access Token ──────────────────────────────────────── */}
      <div className="rounded-2xl border border-white/10 mb-4">
        <div className="px-5 py-3 border-b border-white/10">
          <h3 className="text-sm font-bold text-white">Access Token</h3>
        </div>
        <div className="px-5 py-4">
          <MaskedValue value={waba?.access_token_preview || ""} label="Access Token" />
          <p className="mt-2 text-[11px] text-zinc-500">
            Permanent token from Meta Developer Portal →{" "}
            <strong className="text-zinc-400">WhatsApp → API Setup</strong>
          </p>
          <MetaLink href="https://developers.facebook.com/apps">
            Open Meta Developer Portal
          </MetaLink>
        </div>
      </div>

      {/* ── Phone Number ID ───────────────────────────────────── */}
      {displayPhoneNumberId && (
        <div className="rounded-2xl border border-white/10 mb-4">
          <div className="px-5 py-3 border-b border-white/10">
            <h3 className="text-sm font-bold text-white">Phone Number ID</h3>
          </div>
          <div className="px-5 py-4">
            <div className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white font-mono break-all select-all flex items-center gap-2">
              <span className="flex-1 min-w-0">{displayPhoneNumberId}</span>
              <CopyButton value={displayPhoneNumberId} />
            </div>
            <div className="mt-3 flex flex-wrap gap-3">
              <MetaLink href="https://business.facebook.com/wa/manage-phone-numbers">
                Manage in Business Suite
              </MetaLink>
              <MetaLink href="https://developers.facebook.com/apps">
                Developer Portal
              </MetaLink>
            </div>
          </div>
        </div>
      )}

      {/* ── Edit Credentials ──────────────────────────────────── */}
      <button
        onClick={() => setEditing(!editing)}
        className="w-full rounded-2xl border border-white/10 p-4 text-left transition-colors hover:bg-white/[0.02]"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-white">
              {isConfigured ? "Update WABA Credentials" : "Connect your WABA"}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {isConfigured
                ? "Update your phone number, tokens, or other WABA settings."
                : "Add your WhatsApp Business API credentials to enable outbound messaging."}
            </p>
          </div>
          <div
            className={`w-10 h-6 rounded-full transition-colors ${
              editing ? "bg-[#3EE88A]" : "bg-zinc-700"
            } relative`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                editing ? "translate-x-5" : "translate-x-1"
              }`}
            />
          </div>
        </div>
      </button>

      {editing && (
        <div className="mt-4 rounded-2xl border border-white/10">
          <div className="px-5 py-3 border-b border-white/10">
            <h3 className="text-sm font-bold text-white">WABA Credentials</h3>
          </div>
          <div className="px-5 py-4">
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label htmlFor="whatsapp_business_number" className="block text-xs font-medium text-zinc-400 mb-1">
                  WhatsApp Business Number
                </label>
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-lg border border-r-0 border-white/10 bg-zinc-800 px-3 text-sm text-zinc-400">
                    +91
                  </span>
                  <input
                    id="whatsapp_business_number"
                    name="whatsapp_business_number"
                    value={businessNumber}
                    onChange={(e) => setBusinessNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    placeholder="7021045254"
                    maxLength={10}
                    className="w-full rounded-r-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="phone_number_id" className="block text-xs font-medium text-zinc-400 mb-1">
                  Phone Number ID
                </label>
                <input
                  id="phone_number_id"
                  name="phone_number_id"
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="From Meta Business Dashboard"
                  className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Found in{" "}
                  <a href="https://business.facebook.com" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline">
                    Meta Business Suite
                  </a>{" "}
                  → WhatsApp → Phone Numbers
                </p>
              </div>

              <div>
                <label htmlFor="access_token" className="block text-xs font-medium text-zinc-400 mb-1">
                  Permanent Access Token
                </label>
                <input
                  id="access_token"
                  name="access_token"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder={waba?.has_access_token ? "Leave blank to keep existing" : "Required"}
                  type="password"
                  className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
                />
                {waba?.has_access_token && (
                  <p className="mt-1 text-[11px] text-zinc-500">Token saved. Leave blank to keep it.</p>
                )}
                <div className="mt-3 rounded-lg bg-zinc-800/50 border border-white/5 p-3 space-y-2">
                  <div className="text-[11px] font-semibold text-zinc-300">How to get your Permanent Access Token</div>
                  <ol className="text-[11px] text-zinc-500 space-y-1.5 list-decimal pl-4">
                    <li>
                      Go to{" "}
                      <a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline font-medium">
                        Business Manager → System Users
                      </a>
                    </li>
                    <li>Click <strong className="text-zinc-300">Add</strong> → name it (e.g. "PropAI") → role <strong className="text-zinc-300">Admin</strong></li>
                    <li>Select the system user → <strong className="text-zinc-300">Assign Assets</strong> → choose your <strong className="text-zinc-300">WhatsApp Business Account</strong> → enable <strong className="text-zinc-300">Full Control</strong></li>
                    <li>Click <strong className="text-zinc-300">Generate New Token</strong> → select your app → set expiration to <strong className="text-zinc-300">Never</strong></li>
                    <li>Enable permissions: <code className="text-[#3EE88A]">whatsapp_business_management</code> and <code className="text-[#3EE88A]">whatsapp_business_messaging</code></li>
                    <li>Click <strong className="text-zinc-300">Generate Token</strong> → copy it here</li>
                  </ol>
                  <div className="text-[10px] text-zinc-600">
                    Do NOT use the temporary token from Developer Portal → API Setup. That expires in 24 hours.
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="verify_token" className="block text-xs font-medium text-zinc-400 mb-1">
                  Webhook Verify Token
                </label>
                <input
                  id="verify_token"
                  name="verify_token"
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  placeholder={waba?.has_verify_token ? "Leave blank to keep existing" : "Any random string"}
                  type="password"
                  className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
                />
                {waba?.has_verify_token && (
                  <p className="mt-1 text-[11px] text-zinc-500">Token saved. Leave blank to keep it.</p>
                )}
              </div>

              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-[#3EE88A] px-4 py-2.5 text-sm font-bold text-black disabled:opacity-50 min-h-[44px]"
              >
                {saving ? "Saving..." : "Save Configuration"}
              </button>
            </form>

            {status && (
              <div
                className={`mt-4 text-sm ${
                  status.includes("Saved") || status.includes("saved")
                    ? "text-[#3EE88A]"
                    : "text-[#fca5a5]"
                }`}
              >
                {status}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Quick Links ───────────────────────────────────────── */}
      <div className="mt-6 rounded-2xl border border-white/10">
        <div className="px-5 py-3 border-b border-white/10">
          <h3 className="text-sm font-bold text-white">Meta Dashboard Links</h3>
        </div>
        <div className="px-5 py-4 space-y-2">
          <MetaLink href="https://business.facebook.com/settings/system-users">
            Business Manager — System Users (generate permanent token)
          </MetaLink>
          <MetaLink href="https://developers.facebook.com/apps">
            Meta Developer Portal — App Settings
          </MetaLink>
          <MetaLink href="https://business.facebook.com">
            Meta Business Suite — WhatsApp Manager
          </MetaLink>
          <MetaLink href="https://developers.facebook.com/tools/debug/accesstoken">
            Access Token Debugger (test your token)
          </MetaLink>
        </div>
      </div>
    </div>
  );
}
