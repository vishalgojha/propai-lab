"use client";

import { useEffect, useState } from "react";
import { getCompanionConfig, getConnectionState, type CompanionConfig, type ConnectionState } from "@/lib/api";

const personTypes = ["Broker", "Buyer", "Owner", "Builder", "Developer", "Channel Partner", "Architect"];

function SourcePill({ label, connected }: { label: string; connected: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-zinc-900 px-4 py-3">
      <span className="text-sm font-semibold text-white">{label}</span>
      <span className={`text-xs font-semibold ${connected ? "text-[#3EE88A]" : "text-zinc-500"}`}>
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
          <h2 className="text-lg font-bold text-white">People</h2>
          <p className="mt-2 max-w-2xl text-sm text-zinc-500">
            Brokers, buyers, owners, builders, developers and partners are organized from WhatsApp conversations, with manual entry as a fallback.
          </p>
        </div>
        <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-black no-underline">
          Connect Sources
        </a>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <SourcePill label="WhatsApp" connected={whatsappConnected} />
        <SourcePill label="WhatsApp Business" connected={wabaConnected} />
        <SourcePill label="Manual" connected />
      </div>

      <div className="mt-6 rounded-2xl border border-white/10 bg-zinc-900 p-8 text-center">
        <div className="text-sm font-semibold text-white">No people saved yet.</div>
        <div className="mx-auto mt-2 max-w-xl text-sm text-zinc-500">
          Unknown phone numbers will appear here as Unknown Person once PropAI sees enough conversation activity.
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <a href="/connections" className="rounded-lg bg-[#3EE88A] px-4 py-2 text-sm font-bold text-black no-underline">
            Connect WhatsApp Business
          </a>
          <a href="/connections" className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white no-underline hover:bg-zinc-800">
            Connect WhatsApp
          </a>
          <button className="rounded-lg border border-white/10 px-4 py-2 text-sm text-zinc-400 hover:bg-zinc-800">
            Add Person Manually
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <div className="text-sm font-semibold text-white">Unknown People</div>
          <div className="mt-2 text-sm text-zinc-500">
            New numbers will show as Unknown Person with counts for conversations and groups when those signals exist.
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <div className="text-sm font-semibold text-white">Suggested Type</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {personTypes.map((type) => (
              <span key={type} className="rounded-full border border-white/10 px-3 py-1 text-xs text-zinc-400">
                {type}
              </span>
            ))}
          </div>
          <div className="mt-3 text-sm text-zinc-500">
            AI suggestions will be editable before saving.
          </div>
        </div>
      </div>
    </div>
  );
}
