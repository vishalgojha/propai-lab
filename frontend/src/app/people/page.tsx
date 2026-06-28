"use client";

import { useEffect, useState } from "react";
import { getCompanionConfig, getConnectionState, type CompanionConfig, type ConnectionState } from "@/lib/api";

const personTypes = ["Broker", "Buyer", "Owner", "Builder", "Developer", "Channel Partner", "Architect"];

function SourcePill({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] px-4 py-3">
      <span className="text-sm font-semibold text-[#e2e8f0]">{label}</span>
      <span className={`text-xs font-semibold ${connected ? "text-[#3EE88A]" : "text-[#64748b]"}`}>
        {connected ? "✓ Connected" : "○ Not connected"}
      </span>
    </div>
  );
}

export default function PeoplePage() {
  const [waba, setWaba] = useState<CompanionConfig | null>(null);
  const [whatsapp, setWhatsapp] = useState<ConnectionState | null>(null);

  useEffect(() => {
    getCompanionConfig().then(setWaba).catch(() => setWaba(null));
    getConnectionState().then(setWhatsapp).catch(() => setWhatsapp(null));
  }, []);

  const wabaConnected = Boolean(waba?.phone_number_id && waba?.has_access_token);
  const whatsappConnected = Boolean(whatsapp?.connected);

  return (
    <div className="max-w-5xl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-bold text-[#e2e8f0]">People</h2>
          <p className="mt-2 max-w-2xl text-sm text-[#64748b]">
            Brokers, buyers, owners, builders, developers and partners are organized from WhatsApp conversations, with manual entry as a fallback.
          </p>
        </div>
        <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
          Connect Sources
        </a>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <SourcePill label="WhatsApp" connected={whatsappConnected} />
        <SourcePill label="WhatsApp Business" connected={wabaConnected} />
        <SourcePill label="Manual" connected />
      </div>

      <div className="mt-6 rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-8 text-center">
        <div className="text-sm font-semibold text-[#e2e8f0]">No people saved yet.</div>
        <div className="mx-auto mt-2 max-w-xl text-sm text-[#64748b]">
          Unknown phone numbers will appear here as Unknown Person once PropAI sees enough conversation activity.
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-[#04100a] no-underline">
            Connect WhatsApp Business
          </a>
          <a href="/connections" className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#e2e8f0] no-underline hover:bg-[#111820]">
            Connect WhatsApp
          </a>
          <button className="rounded-lg border border-[rgba(255,255,255,0.1)] px-4 py-2 text-sm text-[#94a3b8] hover:bg-[#111820]">
            Add Person Manually
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
          <div className="text-sm font-semibold text-[#e2e8f0]">Unknown People</div>
          <div className="mt-2 text-sm text-[#64748b]">
            New numbers will show as Unknown Person with counts for conversations and groups when those signals exist.
          </div>
        </div>
        <div className="rounded-2xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
          <div className="text-sm font-semibold text-[#e2e8f0]">Suggested Type</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {personTypes.map((type) => (
              <span key={type} className="rounded-full border border-[rgba(255,255,255,0.08)] px-3 py-1 text-xs text-[#94a3b8]">
                {type}
              </span>
            ))}
          </div>
          <div className="mt-3 text-sm text-[#64748b]">
            AI suggestions will be editable before saving.
          </div>
        </div>
      </div>
    </div>
  );
}
