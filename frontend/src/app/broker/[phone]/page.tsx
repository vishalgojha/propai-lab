"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import * as api from "@/lib/api";
import EntityProfileShell from "@/components/EntityProfileShell";

function digits(value?: string) {
  return (value || "").replace(/\D/g, "");
}

function displayPhone(phone?: string) {
  const local = digits(phone).slice(-10);
  if (local.length !== 10) return phone || "";
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

export default function BrokerPhonePage() {
  const params = useParams<{ phone: string }>();
  const router = useRouter();
  const phone = params.phone || "";
  const [loading, setLoading] = useState(true);
  const [brokerId, setBrokerId] = useState<number | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [broker, setBroker] = useState<any>(null);

  useEffect(() => {
    let mounted = true;

    async function load() {
      if (!phone) return;
      setLoading(true);
      try {
        const resolved = await api.findBroker("", phone);
        if (!mounted) return;
        setBrokerId(resolved.broker_id);
        const full = await api.getBroker(resolved.broker_id);
        if (!mounted) return;
        setBroker(full);
        setSummary(null);
        router.replace(`/brokers/${resolved.broker_id}`);
        return;
      } catch {
        // Fall back to a lightweight phone-based profile.
      }

      try {
        const data = await api.getBrokerSummary("", phone);
        if (!mounted) return;
        setSummary(data);
      } catch {
        if (!mounted) return;
        setSummary(null);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, [phone, router]);

  const display = broker?.name || displayPhone(phone);

  return (
    <EntityProfileShell
      title={display}
      subtitle={broker ? "Canonical broker profile resolved from phone." : "Lightweight broker profile created from phone mentions."}
      backHref="/brokers"
      backLabel="Back to Brokers"
      metrics={[
        { label: "Mentions", value: broker?.observation_count ?? summary?.total_listings ?? 0, tone: "accent" },
        { label: "Listings", value: broker?.listing_count ?? summary?.total_listings ?? 0 },
        { label: "Markets", value: broker?.market_count ?? summary?.markets?.length ?? 0 },
        { label: "Status", value: broker ? "Resolved" : "On demand", tone: "good" },
      ]}
    >
      {loading ? (
        <div className="rounded-2xl border border-white/10 bg-zinc-900 p-6 text-center text-xs text-zinc-500">
          Loading broker profile...
        </div>
      ) : broker ? (
        <div className="rounded-2xl border border-white/10 bg-zinc-900 p-6">
          <div className="text-sm text-zinc-400">
            This route resolved to <span className="text-[#3EE88A]">/brokers/{brokerId}</span>.
          </div>
          <div className="mt-3 text-xs text-zinc-500">
            Use the canonical broker page for the full profile. This route exists so phone-only chips still open something meaningful.
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold text-white">Broker summary</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <StatCard label="Listings" value={summary?.total_listings ?? 0} />
              <StatCard label="Markets" value={summary?.markets?.length ?? 0} />
              <StatCard label="BHK mix" value={summary?.top_bhk?.join(", ") || "—"} />
              <StatCard label="Status" value="On demand" />
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold text-white">Recent coverage</h2>
            <div className="mt-2 text-xs text-zinc-500">The phone number does not yet map to a canonical broker record.</div>
            <div className="mt-4 space-y-2 text-xs text-zinc-300">
              {summary?.markets?.length ? (
                summary.markets.slice(0, 6).map((market: string) => (
                  <div key={market} className="rounded-lg bg-[#0a0f14] px-3 py-2">
                    {market}
                  </div>
                ))
              ) : (
                <div className="rounded-lg bg-[#0a0f14] px-3 py-2 text-zinc-500">
                  No summary data yet for this phone.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </EntityProfileShell>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0a0f14] p-3">
      <div className="text-lg font-bold text-white">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-zinc-500">{label}</div>
    </div>
  );
}
