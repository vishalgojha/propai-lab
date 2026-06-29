"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

function formatPrice(price: number | null, unit: string | null) {
  if (!price) return "—";
  if (unit === "Cr" || unit === "CRORE") return `₹${(price / 10000000).toFixed(1)} Cr`;
  if (unit === "Lac" || unit === "LACS" || unit === "LAKH") return `₹${(price / 100000).toFixed(0)} Lac`;
  if (unit === "K") return `₹${(price / 1000).toFixed(0)}K`;
  if (price >= 10000000) return `₹${(price / 10000000).toFixed(1)} Cr`;
  if (price >= 100000) return `₹${(price / 100000).toFixed(0)} Lac`;
  return `₹${price.toLocaleString()}`;
}

function matchBadge(score: number) {
  if (score >= 80) return "bg-[#3EE88A]/20 text-[#3EE88A]";
  if (score >= 60) return "bg-[#f0c000]/20 text-[#f0c000]";
  return "bg-[#ff6b35]/20 text-[#ff6b35]";
}

function MatchDrawer({ requirementId, onClose }: { requirementId: number; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.getRequirementMatches(requirementId, 20).then(setData).finally(() => setLoading(false));
  }, [requirementId]);

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div className="relative w-full max-w-lg bg-[#0d1117] border-l border-[rgba(255,255,255,0.06)] overflow-y-auto">
          <div className="flex items-center justify-center h-64 text-[#64748b] text-sm">Loading matches...</div>
        </div>
      </div>
    );
  }

  const matches = data?.matches || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#0d1117] border-l border-[rgba(255,255,255,0.06)] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-[#0d1117] border-b border-[rgba(255,255,255,0.06)] p-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-sm font-bold text-[#e2e8f0]">Matching Listings</h3>
            <p className="text-[10px] text-[#64748b] mt-0.5">
              {matches.length} listings match this requirement
            </p>
          </div>
          <button onClick={onClose} className="text-[#64748b] hover:text-white text-lg">✕</button>
        </div>

        {/* Match List */}
        <div className="p-4 space-y-3">
          {matches.length === 0 ? (
            <div className="text-center py-12 text-[#64748b] text-sm">
              No matching listings found. Try adjusting the requirement criteria.
            </div>
          ) : (
            matches.map((m: any, i: number) => {
              const l = m.listing;
              return (
                <div
                  key={i}
                  className="bg-[#111820] border border-[rgba(255,255,255,0.06)] rounded-xl p-4 hover:border-[rgba(88,166,255,0.3)] transition-colors"
                >
                  {/* Header: Score + Listing ID */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${matchBadge(m.match_score)}`}>
                        {m.match_score}% fit
                      </span>
                      <span className="text-[10px] text-[#64748b]">#{l.id}</span>
                    </div>
                    <span className="text-[10px] text-[#64748b]">{l.intent === "SELL" ? "Sale" : l.intent === "RENT" ? "Rent" : "Commercial"}</span>
                  </div>

                  {/* Key Details */}
                  <div className="flex flex-wrap gap-2 mb-2">
                    {l.bhk && <span className="px-2 py-0.5 bg-[#58a6ff]/10 text-[#58a6ff] rounded text-[10px] font-semibold">{l.bhk}</span>}
                    {l.area_sqft && <span className="px-2 py-0.5 bg-[#58a6ff]/10 text-[#58a6ff] rounded text-[10px] font-semibold">{l.area_sqft} sqft</span>}
                    {l.micro_market && <span className="px-2 py-0.5 bg-[#3EE88A]/10 text-[#3EE88A] rounded text-[10px]">{l.micro_market}</span>}
                    {l.building_name && <span className="px-2 py-0.5 bg-[#a78bfa]/10 text-[#a78bfa] rounded text-[10px]">{l.building_name}</span>}
                    {l.furnishing && <span className="px-2 py-0.5 bg-[#f0c000]/10 text-[#f0c000] rounded text-[10px]">{l.furnishing}</span>}
                  </div>

                  {/* Price */}
                  <div className="text-lg font-bold text-[#e2e8f0] mb-2">
                    {formatPrice(l.price, l.price_unit)}
                    {l.intent === "RENT" && l.price ? <span className="text-xs text-[#64748b] font-normal">/mo</span> : null}
                  </div>

                  {/* Match Breakdown */}
                  <div className="grid grid-cols-4 gap-2 text-center mb-2">
                    <div>
                      <div className={`text-xs font-bold ${m.bhk_match >= 0.8 ? "text-[#3EE88A]" : m.bhk_match >= 0.5 ? "text-[#f0c000]" : "text-[#ff6b35]"}`}>
                        {m.bhk_match >= 0.8 ? "✓" : m.bhk_match >= 0.5 ? "~" : "✗"}
                      </div>
                      <div className="text-[9px] text-[#64748b]">{l.bhk ? "BHK" : "Area"}</div>
                    </div>
                    <div>
                      <div className={`text-xs font-bold ${m.market_match >= 0.8 ? "text-[#3EE88A]" : "text-[#ff6b35]"}`}>
                        {m.market_match >= 0.8 ? "✓" : "✗"}
                      </div>
                      <div className="text-[9px] text-[#64748b]">Market</div>
                    </div>
                    <div>
                      <div className={`text-xs font-bold ${m.price_match >= 0.8 ? "text-[#3EE88A]" : m.price_match >= 0.5 ? "text-[#f0c000]" : "text-[#ff6b35]"}`}>
                        {m.price_match >= 0.8 ? "✓" : m.price_match >= 0.5 ? "~" : "✗"}
                      </div>
                      <div className="text-[9px] text-[#64748b]">Price</div>
                    </div>
                    <div>
                      <div className={`text-xs font-bold ${m.building_match >= 0.8 ? "text-[#3EE88A]" : "text-[#64748b]"}`}>
                        {m.building_match >= 0.8 ? "✓" : "—"}
                      </div>
                      <div className="text-[9px] text-[#64748b]">Building</div>
                    </div>
                  </div>

                  {/* Broker Info */}
                  {l.broker_name && (
                    <div className="text-[10px] text-[#64748b]">
                      Broker: <span className="text-[#94a3b8]">{l.broker_name}</span>
                      {l.broker_phone && <span className="ml-2">📞 {l.broker_phone}</span>}
                    </div>
                  )}

                  {/* Activity */}
                  <div className="text-[10px] text-[#64748b] mt-1">
                    {l.observation_count} posts · {l.group_count} groups
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default MatchDrawer;
