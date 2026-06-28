"use client";

import { useEffect, useMemo, useState } from "react";
import { getCompanionConfig, getConnectionState, type CompanionConfig, type ConnectionState } from "@/lib/api";

function SourceRow({ label, detail, connected }: { label: string; detail: string; connected: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] px-4 py-3">
      <div>
        <div className="text-sm font-semibold text-[#e2e8f0]">{label}</div>
        <div className="mt-1 text-xs text-[#64748b]">{detail}</div>
      </div>
      <span className={`text-xs font-semibold ${connected ? "text-[#3EE88A]" : "text-[#64748b]"}`}>
        {connected ? "✓ Connected" : "○ Not connected"}
      </span>
    </div>
  );
}

export default function MyInventoryPage() {
  const [waba, setWaba] = useState<CompanionConfig | null>(null);
  const [whatsapp, setWhatsapp] = useState<ConnectionState | null>(null);

  useEffect(() => {
    getCompanionConfig().then(setWaba).catch(() => setWaba(null));
    getConnectionState().then(setWhatsapp).catch(() => setWhatsapp(null));
  }, []);

  const wabaConnected = Boolean(waba?.phone_number_id && waba?.has_access_token);
  const whatsappConnected = Boolean(whatsapp?.connected);
  const sources = useMemo(
    () => [
      {
        label: "WhatsApp Business API",
        detail: "Automatically collects owned listings from business conversations.",
        connected: wabaConnected,
      },
      {
        label: "WhatsApp",
        detail: "Collects listings from connected WhatsApp activity and groups.",
        connected: whatsappConnected,
      },
      {
        label: "Manual",
        detail: "Fallback when WhatsApp is not connected or a listing could not be parsed.",
        connected: true,
      },
    ],
    [wabaConnected, whatsappConnected]
  );

  return (
    <div className="max-w-5xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-[#e2e8f0]">My Inventory</h2>
          <p className="mt-2 max-w-2xl text-sm text-[#64748b]">
            Your listings are automatically collected from your connected WhatsApp accounts.
          </p>
        </div>
        <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
          Connect WhatsApp Business
        </a>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {sources.map((source) => (
          <SourceRow key={source.label} {...source} />
        ))}
      </div>

      <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center">
        <div className="text-sm font-semibold text-[#e2e8f0]">
          We haven&apos;t detected any listings belonging to your business yet.
        </div>
        <div className="mx-auto mt-2 max-w-xl text-sm text-[#64748b]">
          Once WhatsApp Business API or WhatsApp is connected, PropAI will surface listings that appear to belong to your business for review and saving.
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
            Connect WhatsApp Business
          </a>
          <a href="/connections" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
            Connect WhatsApp
          </a>
          <button className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#94a3b8] hover:bg-[#111820]">
            Add Manually
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
        <div className="text-sm font-semibold text-[#e2e8f0]">Smart Suggestions</div>
        <div className="mt-2 text-sm text-[#64748b]">
          Listings that look like yours will appear here with actions like Save to My Inventory or Ignore.
        </div>
      </div>
    </div>
  );
}
