"use client";

import { useEffect, useState, useCallback, use } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";

export default function BuildingProfilePage({ params }: { params: Promise<{ building_id: string }> }) {
  const { building_id } = use(params);
  const router = useRouter();
  const [building, setBuilding] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadBuilding = useCallback(async () => {
    try {
      const data = await api.getBuildingProfile(building_id);
      setBuilding(data);
    } catch (e) {
      console.error("Failed to load building", e);
    } finally {
      setLoading(false);
    }
  }, [building_id]);

  useEffect(() => { loadBuilding(); }, [loadBuilding]);

  const handleRefresh = async (provider?: string) => {
    setRefreshing(true);
    try {
      await api.refreshBuilding(building_id, provider);
      alert("Enrichment jobs created");
      loadBuilding();
    } catch (e) {
      alert("Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return <div className="text-[#64748b]">Loading building profile...</div>;
  }

  if (!building) {
    return <div className="text-[#64748b]">Building not found</div>;
  }

  const { building: b, aliases, observations, brokers, price_stats, recent_enrichments } = building;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={() => router.push("/buildings")}
            className="text-[#64748b] text-xs mb-2 hover:text-white"
          >
            ← Back to Buildings
          </button>
          <h1 className="text-xl font-bold">{b.canonical_name}</h1>
          <div className="text-[#64748b] text-sm font-mono">{b.building_id}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => handleRefresh()}
            disabled={refreshing}
            className="bg-[#00ff88] text-black px-3 py-1.5 text-xs font-semibold rounded hover:bg-[#00cc6a] disabled:opacity-50"
          >
            {refreshing ? "Refreshing..." : "Refresh All"}
          </button>
          <button
            onClick={() => handleRefresh("google_places")}
            disabled={refreshing}
            className="border border-[rgba(255,255,255,0.1)] text-[#64748b] px-3 py-1.5 text-xs rounded hover:bg-[#0d1117] disabled:opacity-50"
          >
            Google Places
          </button>
          <button
            onClick={() => handleRefresh("osm")}
            disabled={refreshing}
            className="border border-[rgba(255,255,255,0.1)] text-[#64748b] px-3 py-1.5 text-xs rounded hover:bg-[#0d1117] disabled:opacity-50"
          >
            OSM
          </button>
        </div>
      </div>

      {/* Building Info */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <InfoCard label="Market" value={b.micro_market} />
        <InfoCard label="Developer" value={b.developer} />
        <InfoCard label="Address" value={b.address} />
        <InfoCard label="Pincode" value={b.pincode} />
        <InfoCard label="Latitude" value={b.latitude?.toFixed(6)} />
        <InfoCard label="Longitude" value={b.longitude?.toFixed(6)} />
        <InfoCard label="Status" value={b.status} />
        <InfoCard
          label="Enrichment"
          value={b.enrichment_confidence ? `${(b.enrichment_confidence * 100).toFixed(0)}%` : "—"}
          accent={b.enrichment_confidence >= 0.7}
        />
      </div>

      {/* Aliases */}
      {aliases && aliases.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Known Aliases ({aliases.length})</h3>
          <div className="flex flex-wrap gap-2">
            {aliases.map((a: any, i: number) => (
              <span key={i} className="bg-[rgba(255,255,255,0.06)] text-xs px-2 py-1 rounded">
                {a.alias}
                {a.confidence < 1 && (
                  <span className="text-[#64748b] ml-1">({(a.confidence * 100).toFixed(0)}%)</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Price Stats */}
      {price_stats && price_stats.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Price Intelligence</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">BHK</th>
                  <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Intent</th>
                  <th className="text-right px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Min</th>
                  <th className="text-right px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Max</th>
                  <th className="text-right px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Avg</th>
                  <th className="text-right px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Count</th>
                </tr>
              </thead>
              <tbody>
                {price_stats.map((p: any, i: number) => (
                  <tr key={i} className="hover:bg-[#0d1117]">
                    <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{p.bhk || "—"}</td>
                    <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{p.intent}</td>
                    <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-right font-mono">{formatPrice(p.min_price)}</td>
                    <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-right font-mono">{formatPrice(p.max_price)}</td>
                    <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-right font-mono">{formatPrice(p.avg_price)}</td>
                    <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-right">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Brokers */}
      {brokers && brokers.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Top Brokers ({brokers.length})</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {brokers.slice(0, 12).map((br: any, i: number) => (
              <div key={i} className="bg-[#0a0f14] border border-[rgba(255,255,255,0.06)] rounded-lg p-3">
                <div className="font-semibold text-sm">{br.name}</div>
                <div className="text-[#64748b] text-xs">{br.phone}</div>
                <div className="mt-2 flex gap-3 text-xs">
                  <span className="text-[#00ff88]">{br.listing_count} listings</span>
                  <span className="text-[#ff6b35]">{br.requirement_count} reqs</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Enrichments */}
      {recent_enrichments && recent_enrichments.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Recent Enrichments</h3>
          <div className="space-y-2">
            {recent_enrichments.map((e: any, i: number) => (
              <div key={i} className="bg-[#0a0f14] border border-[rgba(255,255,255,0.06)] rounded p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{e.provider}</span>
                  <span className={`text-xs ${e.status === "enriched" ? "text-[#00ff88]" : e.status === "failed" ? "text-[#ff6b35]" : "text-[#64748b]"}`}>
                    {e.status}
                  </span>
                </div>
                {e.fields_updated && (
                  <div className="text-[#64748b] text-xs mt-1">
                    Fields: {Array.isArray(e.fields_updated) ? e.fields_updated.join(", ") : e.fields_updated}
                  </div>
                )}
                {e.confidence && (
                  <div className="text-[#64748b] text-xs">
                    Confidence: {(e.confidence * 100).toFixed(0)}%
                  </div>
                )}
                <div className="text-[#64748b] text-xs">{e.created_at}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Observations */}
      {observations && observations.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Recent Observations ({observations.length})</h3>
          <div className="space-y-2">
            {observations.slice(0, 20).map((o: any, i: number) => (
              <div key={i} className="bg-[#0a0f14] border border-[rgba(255,255,255,0.06)] rounded p-3 text-sm">
                <div className="flex items-center gap-3 mb-1">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    o.intent === "sale" ? "bg-[#00ff88]/10 text-[#00ff88]" :
                    o.intent === "rent" ? "bg-[#4ecdc4]/10 text-[#4ecdc4]" :
                    "bg-[rgba(255,255,255,0.1)] text-[#64748b]"
                  }`}>
                    {o.intent}
                  </span>
                  {o.bhk && <span className="text-xs">{o.bhk} BHK</span>}
                  {o.price && (
                    <span className="font-mono text-xs">
                      {formatPrice(o.price)} {o.price_unit || ""}
                    </span>
                  )}
                  <span className="text-[#64748b] text-xs">{o.broker_name}</span>
                </div>
                <div className="text-[#64748b] text-xs">
                  {o.group_name} • {o.created_at}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[#0a0f14] border border-[rgba(255,255,255,0.06)] rounded-lg p-3">
      <div className="text-[11px] text-[#64748b] uppercase">{label}</div>
      <div className={`text-sm mt-1 font-semibold ${accent ? "text-[#00ff88]" : "text-white"}`}>
        {value || "—"}
      </div>
    </div>
  );
}

function formatPrice(price: number): string {
  if (!price) return "—";
  if (price >= 10000000) return `₹${(price / 10000000).toFixed(2)} Cr`;
  if (price >= 100000) return `₹${(price / 100000).toFixed(2)} L`;
  return `₹${price.toLocaleString("en-IN")}`;
}
