"use client";

import type { FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  getCompanionConfig,
  getCompanionOverview,
  getConnectionDetail,
  getConnectionState,
  saveCompanionConfig,
  type CompanionConfig,
  type CompanionOverview,
  type ConnectionState,
} from "@/lib/api";

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${connected ? "bg-[#3EE88A]/10 text-[#3EE88A]" : "bg-white/[0.04] text-[#94a3b8]"}`}>
      {connected ? "Connected" : "Not Connected"}
    </span>
  );
}

function IntegrationSection({
  title,
  connected,
  children,
  action,
}: {
  title: string;
  connected: boolean;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-bold text-[#e2e8f0]">{title}</h3>
            <StatusBadge connected={connected} />
          </div>
          <div className="mt-4">{children}</div>
        </div>
        {action}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#090d13] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-[#64748b]">{label}</div>
      <div className="mt-1 text-sm font-semibold text-[#e2e8f0]">{value || "—"}</div>
    </div>
  );
}

export default function ConnectionCenterPage() {
  const [waba, setWaba] = useState<CompanionConfig | null>(null);
  const [overview, setOverview] = useState<CompanionOverview | null>(null);
  const [connection, setConnection] = useState<ConnectionState | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [businessNumber, setBusinessNumber] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [savingWaba, setSavingWaba] = useState(false);
  const [wabaStatus, setWabaStatus] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");

  useEffect(() => {
    getCompanionConfig().then(setWaba).catch(() => setWaba(null));
    getCompanionOverview().then(setOverview).catch(() => setOverview(null));
    getConnectionState().then(setConnection).catch(() => setConnection(null));
    getConnectionDetail().then(setDetail).catch(() => setDetail(null));
    if (typeof window !== "undefined") {
      setCallbackUrl(`${window.location.origin}/api/companion/webhook`);
    }
  }, []);

  useEffect(() => {
    if (!waba) return;
    setBusinessNumber(waba.whatsapp_business_number || "");
    setPhoneNumberId(waba.phone_number_id || "");
  }, [waba]);

  async function refreshWaba() {
    const [nextConfig, nextOverview] = await Promise.all([
      getCompanionConfig().catch(() => null),
      getCompanionOverview().catch(() => null),
    ]);
    if (nextConfig) setWaba(nextConfig);
    if (nextOverview) setOverview(nextOverview);
  }

  async function handleSaveWaba(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingWaba(true);
    setWabaStatus("");
    const form = new FormData(event.currentTarget);
    const nextBusinessNumber = String(form.get("whatsapp_business_number") || "").trim();
    const nextPhoneNumberId = String(form.get("phone_number_id") || "").trim();
    const nextAccessToken = String(form.get("access_token") || "").trim();
    const nextVerifyToken = String(form.get("verify_token") || "").trim();
    const missing = [
      !nextBusinessNumber ? "WhatsApp Business Number" : "",
      !nextPhoneNumberId ? "Phone Number ID" : "",
      !nextAccessToken && !waba?.has_access_token ? "Access Token" : "",
      !nextVerifyToken && !waba?.has_verify_token ? "Webhook Verify Token" : "",
    ].filter(Boolean);
    if (missing.length) {
      setWabaStatus(`Missing: ${missing.join(", ")}`);
      setSavingWaba(false);
      return;
    }

    try {
      const next = await saveCompanionConfig({
        whatsapp_business_number: nextBusinessNumber,
        phone_number_id: nextPhoneNumberId,
        access_token: nextAccessToken,
        verify_token: nextVerifyToken,
      });
      setWaba(next);
      setAccessToken("");
      setVerifyToken("");
      await refreshWaba();
      setWabaStatus(next.has_access_token ? "Saved. Copy the Callback URL and Verify Token into Meta Webhooks to finish connecting." : "Saved, but access token is still missing.");
    } catch (error) {
      setWabaStatus(error instanceof Error ? error.message : "Could not save WhatsApp Business API details.");
    } finally {
      setSavingWaba(false);
    }
  }

  const wabaConnected = Boolean(waba?.phone_number_id && waba?.has_access_token);
  const whatsappConnected = Boolean(connection?.connected);
  const whatsappMetrics = useMemo(
    () => [
      { label: "Number", value: detail?.phone_number || detail?.phone || detail?.connected_number || "—" },
      { label: "Profile", value: detail?.display_name || detail?.profile || "—" },
      { label: "Device", value: detail?.device_name || detail?.device || detail?.platform || "—" },
      { label: "Last Sync", value: detail?.last_sync || detail?.connected_since || "—" },
      { label: "Groups connected", value: detail?.total_groups ?? detail?.group_count ?? detail?.groups_connected ?? "—" },
      { label: "Messages processed", value: detail?.messages_processed ?? detail?.message_count ?? "—" },
    ],
    [detail]
  );

  return (
    <div className="max-w-5xl">
      <div>
        <h2 className="text-lg font-bold text-[#e2e8f0]">Connection Center</h2>
        <p className="mt-2 max-w-2xl text-sm text-[#64748b]">
          Connect the sources that let PropAI build your CRM from everyday WhatsApp activity.
        </p>
      </div>

      <div className="mt-6 space-y-4">
        <IntegrationSection
          title="WhatsApp Business API"
          connected={wabaConnected}
          action={null}
        >
          <p className="max-w-2xl text-sm text-[#64748b]">Automatically sync contacts, listings, requirements, conversations and AI Companion access.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {["Contacts", "Listings", "Buyers", "Conversations", "AI Companion"].map((item) => (
              <div key={item} className="rounded-lg border border-[rgba(255,255,255,0.06)] px-3 py-2 text-xs text-[#94a3b8]">
                ✓ {item}
              </div>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Metric label="Business number" value={waba?.whatsapp_business_number || overview?.whatsapp_business_number || "—"} />
            <Metric label="Phone number ID" value={waba?.phone_number_id || "—"} />
            <Metric label="Token status" value={overview?.token_status || (waba?.has_access_token ? "Configured" : "Missing")} />
          </div>
          <form onSubmit={handleSaveWaba} className="mt-5">
          <div className="mb-3">
            <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">Callback URL for Meta Webhooks</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                readOnly
                value={callbackUrl}
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#090d13] px-3 py-2 text-sm text-[#e2e8f0] outline-none"
              />
              <button
                type="button"
                onClick={() => callbackUrl && navigator.clipboard?.writeText(callbackUrl)}
                className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] hover:bg-[#111820]"
              >
                Copy
              </button>
            </div>
            {callbackUrl.includes("localhost") && (
              <span className="mt-1 block text-xs text-[#fbbf24]">
                Meta needs a public HTTPS URL. Localhost works only for local testing through a tunnel or deployed domain.
              </span>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">WhatsApp Business Number</span>
              <input
                name="whatsapp_business_number"
                value={businessNumber}
                onChange={(event) => setBusinessNumber(event.target.value)}
                placeholder="+91..."
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">Phone Number ID</span>
              <input
                name="phone_number_id"
                value={phoneNumberId}
                onChange={(event) => setPhoneNumberId(event.target.value)}
                placeholder="Meta phone number ID"
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">Access Token</span>
              <input
                name="access_token"
                type="password"
                value={accessToken}
                onChange={(event) => setAccessToken(event.target.value)}
                placeholder={waba?.has_access_token ? `Saved (${waba.access_token_preview})` : "Paste Meta access token"}
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">Webhook Verify Token</span>
              <input
                name="verify_token"
                type="password"
                value={verifyToken}
                onChange={(event) => setVerifyToken(event.target.value)}
                placeholder={waba?.has_verify_token ? `Saved (${waba.verify_token_preview})` : "Create or paste verify token"}
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
              <span className="mt-1 block text-xs text-[#64748b]">
                You create this secret yourself. Example: propai_webhook_2026_9xK42m. Use the same value in Meta webhook setup.
              </span>
            </label>
          </div>
          <div className="mt-3 rounded-xl border border-[rgba(62,232,138,0.16)] bg-[#3EE88A]/[0.04] px-4 py-3 text-sm text-[#94a3b8]">
            Need a permanent token? Create a Meta System User token in{" "}
            <a
              href="https://business.facebook.com/settings/system-users"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#3EE88A] hover:underline"
            >
              Business Settings
            </a>
            {" "}and grant WhatsApp permissions. Meta&apos;s{" "}
            <a
              href="https://developers.facebook.com/docs/whatsapp/business-management-api/get-started"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#3EE88A] hover:underline"
            >
              setup guide
            </a>
            {" "}has the full steps.
          </div>
          <div className="mt-3 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#090d13] px-4 py-3 text-sm text-[#94a3b8]">
            Webhook verify token: a private phrase Meta sends once when connecting the webhook. PropAI checks that it matches, then accepts WhatsApp events. It is not given by Meta; create a strong random value here. In Meta, paste the Callback URL above and the same Verify Token value. Open{" "}
            <a
              href="https://developers.facebook.com/apps/"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#3EE88A] hover:underline"
            >
              Meta Apps
            </a>
            , choose your app, then go to WhatsApp / Webhooks setup. Use Meta&apos;s{" "}
            <a
              href="https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks"
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-[#3EE88A] hover:underline"
            >
              webhook setup guide
            </a>
            {" "}if you need the exact steps.
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={savingWaba}
              className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] disabled:opacity-50"
            >
              {savingWaba ? "Saving..." : "Save Details"}
            </button>
            <a href="/companion" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
              Open Companion
            </a>
            {wabaStatus && <span className={`text-xs ${wabaStatus.startsWith("Missing") || wabaStatus.includes("Could not") ? "text-[#f87171]" : "text-[#3EE88A]"}`}>{wabaStatus}</span>}
          </div>
          </form>
        </IntegrationSection>

        <IntegrationSection
          title="WhatsApp (Baileys)"
          connected={whatsappConnected}
          action={
            <a href="/settings" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
              Connect
            </a>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {whatsappMetrics.map((metric) => (
              <Metric key={metric.label} label={metric.label} value={metric.value} />
            ))}
          </div>
        </IntegrationSection>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
            <h3 className="text-sm font-bold text-[#e2e8f0]">CSV Import</h3>
            <p className="mt-2 text-sm text-[#64748b]">Use imports when existing contacts or listings are outside WhatsApp.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#94a3b8]">Import contacts</button>
              <button className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#94a3b8]">Import listings</button>
            </div>
          </div>

          <div className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
            <h3 className="text-sm font-bold text-[#e2e8f0]">Manual Entry</h3>
            <p className="mt-2 text-sm text-[#64748b]">Always available for records that cannot be collected from connected sources.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a href="/my/inventory" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
                Add property
              </a>
              <a href="/my/buyers" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
                Add buyer
              </a>
              <a href="/people" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
                Add person
              </a>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
          <h3 className="text-sm font-bold text-[#e2e8f0]">Future Integrations</h3>
          <div className="mt-4 flex flex-wrap gap-2">
            {["Google Contacts", "Meta CRM", "HubSpot", "Webhook"].map((name) => (
              <span key={name} className="rounded-full border border-[rgba(255,255,255,0.08)] px-3 py-1 text-xs text-[#64748b]">
                {name} · Disabled
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
