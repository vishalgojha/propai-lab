"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import * as api from "@/lib/api";
import Link from "next/link";
import { displayGroupName } from "@/lib/whatsapp-display";

function shortDate(ts?: string) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function Stats({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl bg-white/6 border border-white/8 px-4 py-3 backdrop-blur-sm">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-[10px] uppercase tracking-[0.25em] text-slate-400 mt-1">{label}</div>
    </div>
  );
}

export default function BrokerShareCardPage() {
  const params = useParams<{ token: string }>();
  const [card, setCard] = useState<api.BrokerShareCardSnapshot | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [currentUrl] = useState(() => (typeof window === "undefined" ? "" : window.location.href));

  useEffect(() => {
    if (!params.token) return;
    api.getBrokerShareCardSnapshot(params.token)
      .then(setCard)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load share card"));
  }, [params.token]);

  async function copyLink() {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#050816] text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="text-lg font-semibold">Share card unavailable</div>
          <p className="mt-2 text-sm text-slate-400">{error}</p>
          <div className="mt-4">
            <Link href="/brokers" className="text-sm text-sky-300 hover:text-sky-200">Back to brokers</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!card) {
    return (
      <div className="min-h-screen bg-[#050816] text-slate-100 flex items-center justify-center">
        <div className="text-sm text-slate-400">Loading snapshot...</div>
      </div>
    );
  }

  const shareText = encodeURIComponent(`PropAI broker snapshot: ${card.broker_name} ${currentUrl}`);
  const whatsappHref = `https://wa.me/?text=${shareText}`;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.18),_transparent_30%),linear-gradient(180deg,#020617,#0f172a_55%,#020617)] text-slate-100 px-4 py-8">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-lg flex-col justify-center">
        <div className="mb-4 flex items-center justify-between text-xs uppercase tracking-[0.35em] text-sky-300">
          <span>PropAI</span>
          <span>Broker Activity Card</span>
        </div>

        <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-[linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))] shadow-[0_30px_100px_rgba(0,0,0,0.45)]">
          <div className="border-b border-white/6 px-5 py-5">
            <div className="text-[10px] uppercase tracking-[0.32em] text-slate-400">WhatsApp activity mirror</div>
            <div className="mt-2 text-3xl font-semibold leading-tight text-white">{card.broker_name}</div>
            <div className="mt-1 text-sm text-slate-300">{card.phone_display || "Phone hidden"}</div>
          </div>

          <div className="grid grid-cols-3 gap-3 px-5 py-5">
            <Stats label="Obs" value={card.total_observations} />
            <Stats label="Supply" value={card.supply_count} />
            <Stats label="Demand" value={card.demand_count} />
          </div>

          <div className="px-5 pb-5">
            <div className="rounded-2xl bg-white/5 border border-white/8 p-4">
              <div className="text-[10px] uppercase tracking-[0.3em] text-slate-400">Top operating areas</div>
              <div className="mt-3 space-y-2">
                {(card.top_markets || []).map((market) => (
                  <div key={market.micro_market} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-slate-100">{market.micro_market}</span>
                    <span className="text-slate-400">{market.observation_count} posts</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 rounded-2xl bg-white/5 border border-white/8 p-4">
              <div className="text-[10px] uppercase tracking-[0.3em] text-slate-400">Top WhatsApp groups</div>
              <div className="mt-3 space-y-2">
                {(card.top_groups || []).map((group) => (
                  <div key={group.group_name} className="flex items-center justify-between gap-3 text-sm">
                    <span className="truncate text-slate-100">{displayGroupName(group.group_name)}</span>
                    <span className="text-slate-400">{group.observation_count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stats label="First seen" value={shortDate(card.first_seen)} />
              <Stats label="Last active" value={shortDate(card.last_active)} />
            </div>
          </div>

          <div className="border-t border-white/6 px-5 py-5">
            <div className="rounded-2xl bg-sky-500/10 border border-sky-400/20 px-4 py-4 text-sm text-sky-100">
              This is what PropAI already knows about your market activity - imagine what it can do for your deals.
            </div>
            <div className="mt-3 text-[10px] uppercase tracking-[0.3em] text-slate-500">PropAI • static snapshot {card.generated_at ? shortDate(card.generated_at) : ""}</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button onClick={copyLink} className="rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white hover:bg-white/15">
                {copied ? "Copied" : "Copy link"}
              </button>
              <a href={whatsappHref} className="rounded-full bg-[#22c55e] px-4 py-2 text-xs font-semibold text-black hover:bg-[#16a34a]">
                Share on WhatsApp
              </a>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
