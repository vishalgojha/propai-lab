"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import * as api from "@/lib/api";
import EntityProfileShell from "@/components/EntityProfileShell";
import { labelFromSlug } from "@/lib/entity-links";

export default function LocalityProfilePage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params.slug || "";
  const locality = useMemo(() => labelFromSlug(slug), [slug]);
  const [marketDetail, setMarketDetail] = useState<any>(null);
  const [results, setResults] = useState<api.RawSearchResult[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);

    Promise.all([
      api.getMarketDetail(locality),
      api.searchRawMessages(locality, 12, 0),
    ])
      .then(([detail, search]) => {
        if (!mounted) return;
        setMarketDetail(detail);
        setResults(search.results || []);
      })
      .catch(() => {
        if (!mounted) return;
        setMarketDetail(null);
        setResults([]);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [locality]);

  const priceRanges = Array.isArray(marketDetail?.price_ranges) ? marketDetail.price_ranges : [];

  return (
    <EntityProfileShell
      title={marketDetail?.name || locality}
      subtitle="Click to explore market intelligence built from WhatsApp messages."
      backHref="/market"
      backLabel="Back to Markets"
      actionSlot={
        <button
          onClick={() => router.push(`/search?q=${encodeURIComponent(locality)}`)}
          className="rounded-lg border border-white/10 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900"
        >
          Open search
        </button>
      }
      metrics={[
        { label: "Listings", value: marketDetail?.observation_count ?? "—", tone: "accent" },
        { label: "Buildings", value: marketDetail?.building_count ?? "—" },
        { label: "Brokers", value: marketDetail?.broker_count ?? "—" },
        { label: "Mentions", value: results.length, tone: "good" },
      ]}
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-2xl border border-white/10 bg-zinc-900 p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-white">Market profile</h2>
              <div className="text-xs text-zinc-500">Activity, inventory, and broker coverage.</div>
            </div>
            <span className="rounded-full border border-[rgba(62,232,138,0.25)] bg-[#3EE88A]/10 px-2 py-0.5 text-[10px] font-semibold text-[#3EE88A]">
              Live profile
            </span>
          </div>

          {loading ? (
            <div className="py-10 text-center text-xs text-zinc-500">Loading locality profile...</div>
          ) : marketDetail ? (
            <div className="mt-4 space-y-4">
              {marketDetail.intents?.length > 0 && (
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                    Demand vs supply
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {marketDetail.intents.map((intent: any) => (
                      <span
                        key={intent.intent}
                        className="rounded-full border border-[rgba(88,166,255,0.2)] bg-blue-500/10 px-2 py-1 text-[10px] font-medium text-blue-300"
                      >
                        {intent.intent}: {intent.c}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {priceRanges.length > 0 && (
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                    Price movement
                  </div>
                  <div className="space-y-2">
                    {priceRanges.slice(0, 4).map((range: any) => (
                      <div key={`${range.bhk}-${range.sample_count}`} className="rounded-lg bg-[#0a0f14] px-3 py-2">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-semibold text-white">{range.bhk} BHK</span>
                          <span className="text-[#3EE88A]">{formatPrice(range.avg_price)}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-zinc-500">
                          Range {formatPrice(range.min_price)} - {formatPrice(range.max_price)} across {range.sample_count} samples
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {marketDetail.buildings?.length > 0 && (
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
                    Top buildings
                  </div>
                  <div className="space-y-1">
                    {marketDetail.buildings.slice(0, 8).map((building: any) => (
                      <button
                        key={building.building_name}
                        onClick={() => router.push(`/buildings/${encodeURIComponent(building.building_name)}`)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left hover:bg-white/5"
                      >
                        <span className="truncate text-xs text-white">{building.building_name}</span>
                        <span className="text-[10px] text-zinc-500">{building.observation_count} msgs</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="py-10 text-center text-xs text-zinc-500">
              No canonical market profile yet. This locality page still opens and can be enriched on demand.
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <h2 className="text-sm font-semibold text-white">Recent activity</h2>
          <div className="mt-1 text-xs text-zinc-500">Recent raw messages mentioning this locality.</div>
          <div className="mt-4 space-y-2">
            {loading ? (
              <div className="py-8 text-center text-xs text-zinc-500">Loading...</div>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500">
                No recent mentions found.
              </div>
            ) : (
              results.map((item) => (
                <div key={item.id} className="rounded-xl bg-[#0a0f14] p-3">
                  <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                    <span className="truncate">{item.group_name || "Direct Message"}</span>
                    <span>{new Date(item.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                  </div>
                  <div className="mt-2 text-xs leading-relaxed text-white" dangerouslySetInnerHTML={{ __html: item.snippet }} />
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </EntityProfileShell>
  );
}

function formatPrice(price?: number) {
  if (!price) return "—";
  if (price >= 10000000) return `₹${(price / 10000000).toFixed(2)} Cr`;
  if (price >= 100000) return `₹${(price / 100000).toFixed(2)} Lac`;
  return `₹${price.toLocaleString("en-IN")}`;
}
