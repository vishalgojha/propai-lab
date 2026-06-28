"use client";

import { useEffect, useMemo, useState } from "react";
import { getCompanionConfig, getConnectionState, type CompanionConfig, type ConnectionState } from "@/lib/api";

function SourceTile({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] px-4 py-3">
      <div className="text-sm font-semibold text-[#e2e8f0]">{label}</div>
      <div className={`mt-2 text-xs font-semibold ${connected ? "text-[#3EE88A]" : "text-[#64748b]"}`}>
        {connected ? "✓ Connected" : "○ Not connected"}
      </div>
    </div>
  );
}

export default function MyBuyersPage() {
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
      { label: "WhatsApp Business chats", connected: wabaConnected },
      { label: "WhatsApp groups", connected: whatsappConnected },
      { label: "Direct conversations", connected: wabaConnected || whatsappConnected },
      { label: "Manual", connected: true },
    ],
    [wabaConnected, whatsappConnected]
  );

  return (
    <div className="max-w-5xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-[#e2e8f0]">My Buyers</h2>
          <p className="mt-2 max-w-2xl text-sm text-[#64748b]">
            Buyer profiles are automatically created from your conversations and market requirements.
          </p>
        </div>
        <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
          Connect WhatsApp Business
        </a>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {sources.map((source) => (
          <SourceTile key={source.label} {...source} />
        ))}
      </div>

      <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center">
        <div className="text-sm font-semibold text-[#e2e8f0]">No buyers detected yet.</div>
        <div className="mx-auto mt-2 max-w-xl text-sm text-[#64748b]">
          As buyer conversations and requirements come in, PropAI will organize matching profiles here.
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
            Connect WhatsApp Business
          </a>
          <a href="/connections" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
            Connect WhatsApp
          </a>
          <button className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#94a3b8] hover:bg-[#111820]">
            Create Buyer Manually
          </button>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
        <div className="text-sm font-semibold text-[#e2e8f0]">Smart Suggestions</div>
        <div className="mt-2 text-sm text-[#64748b]">
          Repeat buyers and market requirements that match your clients will appear here with Merge and Ignore actions.
        </div>
      </div>
    </div>
  );
}
