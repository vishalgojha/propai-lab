"use client";

import type { ReactNode } from "react";
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

  useEffect(() => {
    getCompanionConfig().then(setWaba).catch(() => setWaba(null));
    getCompanionOverview().then(setOverview).catch(() => setOverview(null));
    getConnectionState().then(setConnection).catch(() => setConnection(null));
    getConnectionDetail().then(setDetail).catch(() => setDetail(null));
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

  async function handleSaveWaba() {
    setSavingWaba(true);
    setWabaStatus("");
    try {
      const next = await saveCompanionConfig({
        whatsapp_business_number: businessNumber.trim(),
        phone_number_id: phoneNumberId.trim(),
        access_token: accessToken.trim(),
        verify_token: verifyToken.trim(),
      });
      setWaba(next);
      setAccessToken("");
      setVerifyToken("");
      setWabaStatus("WhatsApp Business API details saved.");
      await refreshWaba();
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
          <p className="max-w-2xl text-sm text-[#64748b]">Automatically sync contacts, listings, buyers, conversations and AI Companion access.</p>
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
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">WhatsApp Business Number</span>
              <input
                value={businessNumber}
                onChange={(event) => setBusinessNumber(event.target.value)}
                placeholder="+91..."
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">Phone Number ID</span>
              <input
                value={phoneNumberId}
                onChange={(event) => setPhoneNumberId(event.target.value)}
                placeholder="Meta phone number ID"
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
            </label>
            <label>
              <span className="mb-1 block text-[10px] uppercase tracking-wider text-[#64748b]">Access Token</span>
              <input
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
                type="password"
                value={verifyToken}
                onChange={(event) => setVerifyToken(event.target.value)}
                placeholder={waba?.has_verify_token ? `Saved (${waba.verify_token_preview})` : "Create or paste verify token"}
                className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-sm text-[#e2e8f0] outline-none focus:border-[#3EE88A]"
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={handleSaveWaba}
              disabled={savingWaba}
              className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] disabled:opacity-50"
            >
              {savingWaba ? "Saving..." : "Save Details"}
            </button>
            <a href="/companion" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
              Open Companion
            </a>
            {wabaStatus && <span className="text-xs text-[#94a3b8]">{wabaStatus}</span>}
          </div>
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
