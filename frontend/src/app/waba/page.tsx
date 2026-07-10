"use client";

export const dynamic = 'force-dynamic';

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import {
  getCompanionConfig,
  saveCompanionConfig,
  type CompanionConfig,
} from "@/lib/api";

const PROPAI_WABA_NUMBER = "+9170210455254";

export default function WabaPage() {
  const [waba, setWaba] = useState<CompanionConfig | null>(null);
  const [businessNumber, setBusinessNumber] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [useOwnWaba, setUseOwnWaba] = useState(false);

  useEffect(() => {
    getCompanionConfig().then((cfg) => {
      setWaba(cfg);
      if (cfg.whatsapp_business_number && cfg.whatsapp_business_number !== PROPAI_WABA_NUMBER) {
        setUseOwnWaba(true);
        const display = cfg.whatsapp_business_number.replace(/^\+91/, "");
        setBusinessNumber(display);
      }
    }).catch(() => setWaba(null));
    if (typeof window !== "undefined") {
      setCallbackUrl(`${window.location.origin}/api/companion/webhook`);
    }
  }, []);

  useEffect(() => {
    if (!waba || useOwnWaba) return;
    setBusinessNumber(waba.whatsapp_business_number?.replace(/^\+91/, "") || "");
    setPhoneNumberId(waba.phone_number_id || "");
  }, [waba, useOwnWaba]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setStatus("");

    const form = new FormData(event.currentTarget);
    const raw = String(form.get("whatsapp_business_number") || "").trim();
    const cleaned = raw.replace(/^\+91/, "");
    const nextBusinessNumber = useOwnWaba && cleaned ? `+91${cleaned}` : "";
    const nextPhoneNumberId = useOwnWaba ? String(form.get("phone_number_id") || "").trim() : "";
    const nextAccessToken = useOwnWaba ? String(form.get("access_token") || "").trim() : "";
    const nextVerifyToken = useOwnWaba ? String(form.get("verify_token") || "").trim() : "";

    if (useOwnWaba) {
      const missing = [
        !cleaned ? "WhatsApp Business Number" : "",
        !nextPhoneNumberId ? "Phone Number ID" : "",
        !nextAccessToken && !waba?.has_access_token ? "Access Token" : "",
        !nextVerifyToken && !waba?.has_verify_token ? "Webhook Verify Token" : "",
      ].filter(Boolean);
      if (missing.length) {
        setStatus(`Missing: ${missing.join(", ")}`);
        setSaving(false);
        return;
      }
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
      const [config] = await Promise.all([
        getCompanionConfig().catch(() => null),
      ]);
      if (config) setWaba(config);
      setStatus("Configuration saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save WhatsApp Business API details.");
    } finally {
      setSaving(false);
    }
  }

  const wabaConnected = Boolean(waba?.phone_number_id && waba?.has_access_token);

  return (
    <div className="max-w-3xl mx-auto px-4 lg:px-0 py-8">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">WhatsApp Business API</h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-500">
          PropAI uses the WhatsApp Business API to send outbound messages (alerts, notifications, property cards) to your clients.
        </p>
      </div>

      {/* PropAI Shared WABA */}
      <div className="rounded-2xl border border-[#3EE88A]/20 p-5 mb-4">
        <div className="flex items-start gap-4">
          <div className="w-2 h-2 rounded-full bg-[#3EE88A] mt-1.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-bold text-white">PropAI Shared WABA</div>
            <div className="mt-1 text-sm text-zinc-300">
              <span className="text-zinc-500">Number:</span> {PROPAI_WABA_NUMBER}
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              All PropAI users can send outbound messages through this shared WhatsApp Business account.
              No setup required — it works out of the box.
            </p>
          </div>
        </div>
      </div>

      {/* Toggle own WABA */}
      <button
        onClick={() => setUseOwnWaba(!useOwnWaba)}
        className="w-full rounded-2xl border border-white/10 p-4 text-left transition-colors"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-white">Connect your own WABA</div>
            <p className="mt-1 text-xs text-zinc-500">
              Use your own WhatsApp Business Account for org-specific messaging.
            </p>
          </div>
          <div className={`w-10 h-6 rounded-full transition-colors ${useOwnWaba ? "bg-[#3EE88A]" : "bg-zinc-700"} relative`}>
            <div className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${useOwnWaba ? "translate-x-5" : "translate-x-1"}`} />
          </div>
        </div>
      </button>

      {useOwnWaba && (
        <>
          <div className="mt-4 rounded-2xl border border-white/10">
            <div className="px-5 py-3 border-b border-white/10">
              <h3 className="text-sm font-bold text-white">Your WABA Credentials</h3>
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
                <p className="mt-1 text-[11px] text-zinc-500">Enter the 10-digit number without +91.</p>
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
                  → WhatsApp Account → Phone Numbers.
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
                  <p className="mt-1 text-[11px] text-zinc-500">Token already saved. Leave blank to keep it.</p>
                )}
                <details className="mt-2">
                  <summary className="text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300">How to get your Permanent Access Token</summary>
                  <div className="mt-2 text-[11px] text-zinc-500 space-y-1.5 pl-3 border-l border-white/10">
                    <p>1. Go to the{" "}
                      <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline">
                        Meta Developer Portal
                      </a>
                    </p>
                    <p>2. Select your WhatsApp Business App</p>
                    <p>3. Go to <strong className="text-zinc-300">WhatsApp → API Setup</strong></p>
                    <p>4. Find the <strong className="text-zinc-300">Temporary Access Token</strong> (valid for 24 hours)</p>
                    <p>5. To make it permanent:</p>
                    <p className="pl-3">— Go to{" "}
                      <a href="https://developers.facebook.com/tools/accesstoken/" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline">
                        Tools → Access Token Tool
                      </a>
                    </p>
                    <p className="pl-3">— Click <strong className="text-zinc-300">Extend Token</strong> on your temporary token</p>
                    <p className="pl-3">— Copy the <strong className="text-zinc-300">extended token</strong> and paste it here</p>
                    <p className="mt-2 text-zinc-600">This token never expires once extended.</p>
                  </div>
                </details>
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
                  placeholder={waba?.has_verify_token ? "Leave blank to keep existing" : "Enter any random string"}
                  type="password"
                  className="w-full rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-[#3EE88A]"
                />
                {waba?.has_verify_token && (
                  <p className="mt-1 text-[11px] text-zinc-500">Verify token already saved. Leave blank to keep it.</p>
                )}
                <details className="mt-2">
                  <summary className="text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300">What is a Verify Token?</summary>
                  <div className="mt-2 text-[11px] text-zinc-500 space-y-1.5 pl-3 border-l border-white/10">
                    <p>A Verify Token is a <strong className="text-zinc-300">random string you create</strong> — think of it as a password that Meta uses to verify your webhook endpoint.</p>
                    <p>It can be anything: <code className="text-[#3EE88A]">propai-webhook-123</code>, <code className="text-[#3EE88A]">my-org-verify-456</code>, etc.</p>
                    <p>You set the same string in two places:</p>
                    <p className="pl-3">1. Here, in this field</p>
                    <p className="pl-3">2. In the Meta App Dashboard under <strong className="text-zinc-300">WhatsApp → Configuration → Webhook → Verify Token</strong></p>
                    <p>When Meta sends a verification request, PropAI's server responds with this token to confirm the webhook URL belongs to you.</p>
                  </div>
                </details>
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
              <div className={`mt-4 text-sm ${status.includes("Saved") || status.includes("saved") ? "text-[#3EE88A]" : "text-[#fca5a5]"}`}>
                {status}
              </div>
            )}
            </div>
          </div>

          {wabaConnected && (
            <div className="mt-6 rounded-2xl border border-white/10">
              <div className="px-5 py-3 border-b border-white/10">
                <h3 className="text-sm font-bold text-white">Webhook Setup</h3>
              </div>
              <div className="px-5 py-4">
              <p className="text-sm text-zinc-500 mb-3">
                Add this Callback URL and your Verify Token in the Meta App Dashboard under{" "}
                <strong className="text-zinc-300">WhatsApp → Configuration → Webhook</strong>.
              </p>
              <div className="space-y-3">
                <div>
                  <div className="text-xs font-medium text-zinc-400 mb-1">Callback URL</div>
                  <div className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white font-mono break-all select-all">
                    {callbackUrl}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium text-zinc-400 mb-1">Verify Token</div>
                  <div className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white font-mono break-all">
                    {waba?.has_verify_token ? "•••••••• (saved)" : "Not configured"}
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}
        </>
      )}

      <div className="mt-6 rounded-2xl border border-white/10">
        <div className="px-5 py-3 border-b border-white/10">
          <h3 className="text-sm font-bold text-white">Need help?</h3>
        </div>
        <div className="px-5 py-4">
        <div className="space-y-2 text-xs text-zinc-500">
          <p>
            <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline">
              Meta WhatsApp Cloud API Docs
            </a>
          </p>
          <p>
            <a href="https://business.facebook.com" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline">
              Meta Business Suite
            </a>
          </p>
          <p>
            <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" className="text-[#3EE88A] underline">
              Meta Developer Portal
            </a>
          </p>
        </div>
      </div>
      </div>
    </div>
  );
}

