"use client";

import { useEffect, useState, useCallback, use } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function BuildingProfilePage({ params }: { params: Promise<{ building_id: string }> }) {
  const { building_id } = use(params);
  const router = useRouter();
  const [building, setBuilding] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackMentions, setFallbackMentions] = useState<api.RawSearchResult[]>([]);

  const loadBuilding = useCallback(async () => {
    try {
      const data = await api.getBuildingProfile(building_id);
      setBuilding(data);
      setFallbackMentions([]);
    } catch (e) {
      console.error("Failed to load building", e);
      setBuilding(null);
      try {
        const search = await api.searchRawMessages(building_id, 12, 0);
        setFallbackMentions(search.results || []);
      } catch {
        setFallbackMentions([]);
      }
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
    return (
      <div className="max-w-5xl space-y-6">
        <div>
          <Link href="/buildings" className="text-[11px] text-[#64748b] hover:text-white transition-colors">
            Back to Buildings
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-[#e2e8f0]">{building_id}</h1>
          <div className="mt-1 text-sm text-[#64748b]">
            Lightweight building profile created on demand from captured mentions.
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <InfoCard label="Profile status" value="On demand" />
          <InfoCard label="Mentions" value={fallbackMentions.length} />
          <InfoCard label="Profile type" value="Building" />
          <InfoCard label="Coverage" value={fallbackMentions.length > 0 ? "Found" : "Empty"} />
        </div>

        <div className="rounded-xl border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[#e2e8f0]">Recent mentions</h2>
              <div className="text-xs text-[#64748b]">Search hits that reference this building name.</div>
            </div>
            <button
              onClick={() => router.push(`/search?q=${encodeURIComponent(building_id)}`)}
              className="text-xs font-semibold text-[#3EE88A] hover:underline"
            >
              Open search
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {fallbackMentions.length === 0 ? (
              <div className="py-10 text-center text-xs text-[#64748b]">
                No canonical building profile yet. The chip still resolves here, so the entity has a stable landing page.
              </div>
            ) : (
              fallbackMentions.map((item) => (
                <div key={item.id} className="rounded-xl bg-[#0a0f14] p-3">
                  <div className="flex items-center justify-between gap-2 text-[10px] text-[#64748b]">
                    <span className="truncate">{item.group_name || "Direct Message"}</span>
                    <span>{new Date(item.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                  </div>
                  <div className="mt-2 text-xs leading-relaxed text-[#e2e8f0]" dangerouslySetInnerHTML={{ __html: item.snippet }} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
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

function InfoCard({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
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
