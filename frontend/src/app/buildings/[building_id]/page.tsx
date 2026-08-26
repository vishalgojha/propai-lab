"use client";

import { useEffect, useState, useCallback, use } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";
import Link from "next/link";
import NotesPanel from "@/components/notes/NotesPanel";
import { displayGroupName } from "@/lib/whatsapp-display";
import { marketRecordHref } from "@/lib/market-record-links";

export default function BuildingProfilePage({ params }: { params: Promise<{ building_id: string }> }) {
  const { building_id } = use(params);
  const normalizedBuildingId = (() => {
    try {
      return decodeURIComponent(building_id);
    } catch {
      return building_id;
    }
  })();
  const router = useRouter();
  const [building, setBuilding] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fallbackMentions, setFallbackMentions] = useState<api.RawSearchResult[]>([]);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const loadBuilding = useCallback(async () => {
    try {
      const data = await api.getBuildingProfile(normalizedBuildingId);
      setBuilding(data);
      setFallbackMentions([]);
    } catch {
      console.error("Failed to load building", e);
      setBuilding(null);
      try {
        const search = await api.searchRawMessages(normalizedBuildingId, 12, 0);
        setFallbackMentions(search.results || []);
      } catch {
        setFallbackMentions([]);
      }
    } finally {
      setLoading(false);
    }
  }, [normalizedBuildingId]);

  useEffect(() => { loadBuilding(); }, [loadBuilding]);

  const handleRefresh = async (provider?: string) => {
    setRefreshing(true);
    try {
      await api.refreshBuilding(normalizedBuildingId, provider);
      setToast({ tone: "success", message: "Enrichment queued. PropAI will refresh this building when the worker completes." });
      loadBuilding();
    } catch {
      setToast({ tone: "error", message: "PropAI could not queue enrichment for this building." });
    } finally {
      setRefreshing(false);
    }
  };

  const handleGeocode = async () => {
    setRefreshing(true);
    try {
      await api.geocodeBuilding(normalizedBuildingId);
      setToast({ tone: "success", message: "Building address refreshed." });
      await loadBuilding();
    } catch {
      setToast({ tone: "error", message: "PropAI could not refresh the building address." });
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return <div className="text-zinc-500">Loading building profile...</div>;
  }

  if (!building) {
    return (
      <div className="max-w-5xl space-y-6">
        <div>
          <Link href="/buildings" className="text-[11px] text-zinc-500 hover:text-white transition-colors">
            Back to Buildings
          </Link>
          <h1 className="mt-2 text-2xl font-bold text-white">{normalizedBuildingId}</h1>
          <div className="mt-1 text-sm text-zinc-500">
            Evidence view from captured WhatsApp mentions. A canonical building profile is not available yet.
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <InfoCard label="Profile status" value="Evidence only" />
          <InfoCard label="Mentions" value={fallbackMentions.length} />
          <InfoCard label="Profile type" value="Building" />
          <InfoCard label="Coverage" value={fallbackMentions.length > 0 ? "Search matches" : "No matches"} />
        </div>

        <div className="rounded-xl border border-white/10 bg-zinc-900 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">Recent mentions</h2>
              <div className="text-xs text-zinc-500">Search hits that reference this building name.</div>
            </div>
            <button
              onClick={() => router.push("/chat")}
              className="text-xs font-semibold text-[#3EE88A] hover:underline"
            >
              Open search
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {fallbackMentions.length === 0 ? (
              <div className="py-10 text-center text-xs text-zinc-500">
                No captured messages matched this exact building name. PropAI will only create a canonical profile after the name is grounded with locality evidence.
              </div>
            ) : (
              fallbackMentions.map((item) => (
                <div key={item.id} className="rounded-xl bg-[#0a0f14] p-3">
                  <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                    <span className="truncate">{displayGroupName(item.group_name) || "Direct Message"}</span>
                    <span>{new Date(item.timestamp).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span>
                  </div>
                  <div className="mt-2 text-xs leading-relaxed text-white" dangerouslySetInnerHTML={{ __html: item.snippet }} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  // The building profile API returns the building fields at the top level.
  // Keep accepting a nested `building` response for older deployments while
  // rendering the current contract correctly.
  const b = building.building ?? building;
  const aliases = building.aliases ?? [];
  const listings = building.listings ?? [];
  const requirements = building.requirements ?? [];
  const observations = building.observations ?? [];
  const brokers = building.brokers ?? [];
  const price_stats = building.price_stats ?? [];
  const recent_enrichments = building.recent_enrichments ?? building.sources ?? [];

  return (
    <div className="relative space-y-6">
      {toast && <div role="status" className={`fixed right-6 top-6 z-50 max-w-sm rounded-xl border px-4 py-3 shadow-2xl ${toast.tone === "success" ? "border-[#00ff88]/30 bg-[#10251b] text-emerald-100" : "border-red-300/30 bg-[#2a1418] text-red-100"}`}>
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#00ff88]">PropAI</div>
        <div className="mt-1 text-sm">{toast.message}</div>
        <button type="button" onClick={() => setToast(null)} className="mt-2 text-xs font-semibold underline underline-offset-2">Dismiss</button>
      </div>}
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <button
            onClick={() => router.push("/buildings")}
            className="text-zinc-500 text-xs mb-2 hover:text-white"
          >
            ← Back to Buildings
          </button>
          <h1 className="text-xl font-bold">{b.canonical_name}</h1>
          <div className="text-zinc-500 text-sm font-mono">{b.building_id}</div>
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
            onClick={handleGeocode}
            disabled={refreshing}
            className="border border-white/10 text-zinc-500 px-3 py-1.5 text-xs rounded hover:bg-zinc-900 disabled:opacity-50"
          >
            {b.geocoded_at ? "Refresh Address" : "Find Address"}
          </button>
        </div>
      </div>

      {/* Building Info */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <InfoCard label="Market" value={b.micro_market} />
        <InfoCard label="Developer" value={b.developer} />
        <InfoCard label="Address" value={b.address} />
        <InfoCard label="Pincode" value={b.pincode} />
        <InfoCard label="Status" value={b.status} />
        <InfoCard
          label="Enrichment"
          value={b.enrichment_confidence ? `${(b.enrichment_confidence * 100).toFixed(0)}%` : "—"}
          accent={b.enrichment_confidence >= 0.7}
        />
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold mb-1">Listings linked to this building ({listings.length})</h3>
            <p className="text-xs text-zinc-500">Parsed listing records matched to the canonical building name or a known alias. Open any row to inspect its source evidence.</p>
          </div>
        </div>
        {listings.length === 0 ? <div className="mt-3 rounded-lg border border-white/10 bg-[#0a0f14] p-4 text-xs text-zinc-500">No listing records are linked yet.</div> : <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-white/[0.03] text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <tr><th className="px-3 py-2">Listing</th><th className="px-3 py-2">Intent</th><th className="px-3 py-2">BHK</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Broker</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Evidence</th></tr>
            </thead>
            <tbody>{listings.map((listing: any, index: number) => <tr key={`${listing.source_schema || listing._typed_table}-${listing.id || index}`} className="border-t border-white/10 align-top">
              <td className="px-3 py-2 text-white">{(() => { const href = marketRecordHref(listing, listing.summary_title); return href ? <Link href={href} className="font-medium text-emerald-300 hover:underline">{listing.summary_title || listing.property_type || "Parsed listing"}</Link> : (listing.summary_title || listing.property_type || "Parsed listing"); })()}</td>
              <td className="px-3 py-2 text-zinc-300">{listing.transaction_type || "—"}</td>
              <td className="px-3 py-2 text-zinc-300">{listing.bhk || "—"}</td>
              <td className="px-3 py-2 font-mono text-emerald-200">{formatPrice(Number(listing.price || 0))}</td>
              <td className="px-3 py-2 text-zinc-300">{listing.broker_name || "—"}</td>
              <td className="px-3 py-2 text-zinc-500">{listing.last_seen ? new Date(listing.last_seen).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</td>
              <td className="px-3 py-2">{marketRecordHref(listing, listing.summary_title) ? <Link href={marketRecordHref(listing, listing.summary_title) as string} className="text-emerald-300 hover:underline">Open evidence</Link> : <span className="text-zinc-600">Unavailable</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold mb-1">Requirements linked to this building ({requirements.length})</h3>
            <p className="text-xs text-zinc-500">Demand-side records are kept separate from supply listings and open through the same evidence-preserving view.</p>
          </div>
        </div>
        {requirements.length === 0 ? <div className="mt-3 rounded-lg border border-white/10 bg-[#0a0f14] p-4 text-xs text-zinc-500">No requirement records are linked yet.</div> : <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-white/[0.03] text-left text-[10px] uppercase tracking-wider text-zinc-500"><tr><th className="px-3 py-2">Requirement</th><th className="px-3 py-2">Intent</th><th className="px-3 py-2">Budget</th><th className="px-3 py-2">Broker</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Evidence</th></tr></thead>
            <tbody>{requirements.map((requirement: any, index: number) => { const href = marketRecordHref(requirement, requirement.summary_title); return <tr key={`${requirement.source_schema || requirement._typed_table}-${requirement.id || index}`} className="border-t border-white/10 align-top"><td className="px-3 py-2 text-white">{href ? <Link href={href} className="font-medium text-emerald-300 hover:underline">{requirement.summary_title || "Parsed requirement"}</Link> : (requirement.summary_title || "Parsed requirement")}</td><td className="px-3 py-2 text-zinc-300">{requirement.transaction_type || "—"}</td><td className="px-3 py-2 font-mono text-emerald-200">{formatPrice(Number(requirement.price || requirement.budget_max || 0))}</td><td className="px-3 py-2 text-zinc-300">{requirement.broker_name || "—"}</td><td className="px-3 py-2 text-zinc-500">{requirement.last_seen ? new Date(requirement.last_seen).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</td><td className="px-3 py-2">{href ? <Link href={href} className="text-emerald-300 hover:underline">Open evidence</Link> : <span className="text-zinc-600">Unavailable</span>}</td></tr>; })}</tbody>
          </table>
        </div>}
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
                  <span className="text-zinc-500 ml-1">({(a.confidence * 100).toFixed(0)}%)</span>
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
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">BHK</th>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Intent</th>
                  <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Min</th>
                  <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Max</th>
                  <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Avg</th>
                  <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Count</th>
                </tr>
              </thead>
              <tbody>
                {price_stats.map((p: any, i: number) => (
                  <tr key={i} className="hover:bg-zinc-900">
                    <td className="px-2.5 py-2 border-b border-white/10">{p.bhk || "—"}</td>
                    <td className="px-2.5 py-2 border-b border-white/10">{p.intent}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono">{formatPrice(p.min_price)}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono">{formatPrice(p.max_price)}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono">{formatPrice(p.avg_price)}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right">{p.count}</td>
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
              <div key={i} className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
                <div className="font-semibold text-sm">{br.name}</div>
                <div className="text-zinc-500 text-xs">{br.phone}</div>
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
              <div key={i} className="bg-[#0a0f14] border border-white/10 rounded p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{e.provider}</span>
                  <span className={`text-xs ${e.status === "enriched" ? "text-[#00ff88]" : e.status === "failed" ? "text-[#ff6b35]" : "text-zinc-500"}`}>
                    {e.status}
                  </span>
                </div>
                {e.fields_updated && (
                  <div className="text-zinc-500 text-xs mt-1">
                    Fields: {Array.isArray(e.fields_updated) ? e.fields_updated.join(", ") : e.fields_updated}
                  </div>
                )}
                {e.confidence && (
                  <div className="text-zinc-500 text-xs">
                    Confidence: {(e.confidence * 100).toFixed(0)}%
                  </div>
                )}
                <div className="text-zinc-500 text-xs">{e.created_at}</div>
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
              <div key={i} className="bg-[#0a0f14] border border-white/10 rounded p-3 text-sm">
                <div className="flex items-center gap-3 mb-1">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    o.intent === "sale" ? "bg-[#00ff88]/10 text-[#00ff88]" :
                    o.intent === "rent" ? "bg-[#4ecdc4]/10 text-[#4ecdc4]" :
                    "bg-[rgba(255,255,255,0.1)] text-zinc-500"
                  }`}>
                    {o.intent}
                  </span>
                  {o.bhk && <span className="text-xs">{o.bhk} BHK</span>}
                  {o.price && (
                    <span className="font-mono text-xs">
                      {formatPrice(o.price)} {o.price_unit || ""}
                    </span>
                  )}
                  <span className="text-zinc-500 text-xs">{o.broker_name}</span>
                </div>
                <div className="text-zinc-500 text-xs">
                  {displayGroupName(o.group_name) || "Unknown Group"} • {o.created_at}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <hr className="border-zinc-800" />
      <NotesPanel entityType="building" entityId={building_id} />
    </div>
  );
}

function InfoCard({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
      <div className="text-[11px] text-zinc-500 uppercase">{label}</div>
      <div className={`text-sm mt-1 font-semibold ${accent ? "text-[#00ff88]" : "text-white"}`}>
        {value || "—"}
      </div>
    </div>
  );
}

function formatPrice(price: number): string {
  if (!price) return "—";
  if (price >= 10000000) return `₹${(price / 10000000).toFixed(2)} Cr`;
  if (price >= 100000) return `₹${(price / 100000).toFixed(2)} Lakh`;
  return `₹${price.toLocaleString("en-IN")}`;
}
