"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import * as api from "@/lib/api";

function MarketsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialMarket = searchParams.get("q") || "";

  const [heatmap, setHeatmap] = useState<any[]>([]);
  const [coverage, setCoverage] = useState<api.DashboardCoverage | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<string | null>(initialMarket);
  const [marketDetail, setMarketDetail] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([api.getDashboardHeatmap(), api.getDashboardCoverage()]).then(([h, c]) => {
      setHeatmap(h);
      setCoverage(c);
    });
  }, []);

  useEffect(() => {
    if (selectedMarket) {
      setLoading(true);
      api.getMarketDetail(selectedMarket)
        .then(setMarketDetail)
        .catch(() => setMarketDetail(null))
        .finally(() => setLoading(false));
    } else {
      setMarketDetail(null);
    }
  }, [selectedMarket]);

  const maxHeat = heatmap.length > 0 ? heatmap[0].c : 1;
  const topMarkets = heatmap.slice(0, 30);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">Markets</h2>

      {/* Summary Cards — clickable to see detail */}
      <div className="grid grid-cols-4 gap-3">
        {[
          ["Markets", coverage?.micro_markets_known],
          ["Buildings", coverage?.buildings_known],
          ["Landmarks", coverage?.landmarks_known],
          ["Developers", coverage?.developers_known],
        ].map(([l, v]) => (
          <div key={l as string} className="bg-zinc-900 border border-white/10 rounded-2xl p-4 text-center">
            <div className="text-3xl font-bold text-white">{v ?? "—"}</div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mt-1">{l as string}</div>
          </div>
        ))}
      </div>

      {/* Two-panel: Market List + Detail */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        {/* Left: Market list */}
        <div className="md:col-span-2 bg-zinc-900 border border-white/10 rounded-2xl p-5">
          <div className="text-[11px] text-zinc-500 uppercase tracking-widest font-bold mb-3">
            MARKETS ({heatmap.length})
            <span className="text-[10px] font-normal lowercase ml-2">— active across broker groups</span>
          </div>
          <div className="max-h-[500px] overflow-y-auto space-y-0.5">
            {topMarkets.map((h, i) => (
              <button
                key={h.micro_market}
                onClick={() => setSelectedMarket(h.micro_market)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
                  selectedMarket === h.micro_market
                    ? "bg-blue-600/20 border border-blue-500/30"
                    : "hover:bg-white/5"
                }`}
              >
                <span className="text-[10px] text-zinc-500 w-5 shrink-0">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-white truncate">{h.micro_market}</div>
                  <div className="flex gap-3 text-[10px] text-zinc-500">
                    <span>{h.c} messages</span>
                  </div>
                </div>
                <div className="w-16 h-1.5 bg-[rgba(255,255,255,0.06)] rounded-full overflow-hidden shrink-0">
                  <div className="h-full bg-blue-500/60 rounded-full" style={{ width: `${Math.max(3, (h.c / maxHeat) * 100)}%` }} />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right: Market detail */}
        <div className="md:col-span-3">
          {!selectedMarket && (
            <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5 text-center text-zinc-500">
              <div className="text-2xl mb-2">🗺️</div>
              <div className="text-sm">Select a market to explore</div>
              <div className="text-xs mt-1">Buildings, brokers, buyer activity and listings in that area</div>
            </div>
          )}

          {loading && (
            <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5 text-center text-zinc-500">
              Loading...
            </div>
          )}

          {marketDetail && !loading && (
            <div className="space-y-4">
              <div className="bg-zinc-900 border border-white/10 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-bold text-white">{marketDetail.name}</div>
                    <div className="text-[10px] text-zinc-500">Activity from broker groups</div>
                  </div>
                  <div className="flex gap-3">
                    <div className="text-center">
                      <div className="text-lg font-bold text-white">{marketDetail.building_count}</div>
                      <div className="text-[10px] text-zinc-500">Buildings</div>
                    </div>
                    <div className="text-center">
                      <div className="text-lg font-bold text-white">{marketDetail.broker_count}</div>
                      <div className="text-[10px] text-zinc-500">Brokers</div>
                    </div>
                  </div>
                </div>

                {/* Intent breakdown */}
                {marketDetail.intents && marketDetail.intents.length > 0 && (
                  <div className="flex gap-2 flex-wrap mb-3">
                    {marketDetail.intents.map((intent: any) => (
                      <span key={intent.intent} className="text-[10px] font-medium text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                        {intent.intent}: {intent.c}
                      </span>
                    ))}
                  </div>
                )}

                {/* Buildings in this market */}
                {marketDetail.buildings && marketDetail.buildings.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">Top Buildings</div>
                    <div className="space-y-1">
                      {marketDetail.buildings.map((b: any, i: number) => (
                        <button
                          key={i}
                          onClick={() => router.push(`/buildings/${encodeURIComponent(b.building_name)}`)}
                          className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-white/5 text-left transition-colors cursor-pointer"
                        >
                          <span className="text-xs text-white truncate">{b.building_name}</span>
                          <span className="text-[10px] text-zinc-500">{b.observation_count} msgs</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Brokers active here */}
                {marketDetail.brokers && marketDetail.brokers.length > 0 && (
                  <div className="mt-3 border-t border-white/10 pt-3">
                    <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">Active Brokers</div>
                    <div className="space-y-1">
                      {marketDetail.brokers.slice(0, 5).map((b: any, i: number) => (
                        <button
                          key={i}
                          onClick={() => router.push(`/brokers/${b.id}`)}
                          className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-white/5 text-left transition-colors cursor-pointer"
                        >
                          <span className="text-xs text-white">{b.name}</span>
                          <span className="text-[10px] text-zinc-500">{b.listing_count} listings / {b.requirement_count} requirements</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Groups covering this market */}
                {marketDetail.groups && marketDetail.groups.length > 0 && (
                  <div className="mt-3 border-t border-white/10 pt-3">
                    <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1">Covered By Groups</div>
                    <div className="flex gap-1 flex-wrap">
                      {marketDetail.groups.map((g: any, i: number) => (
                        <span key={i} className="text-[10px] text-zinc-400 bg-white/5 px-2 py-0.5 rounded">
                          {g.group_name?.slice(0, 25)}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function MarketsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-[var(--text-muted)]">Loading markets...</div>}>
      <MarketsContent />
    </Suspense>
  );
}
