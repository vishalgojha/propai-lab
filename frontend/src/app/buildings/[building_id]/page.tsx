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
  const [contacting, setContacting] = useState<string | null>(null);
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

  const handleContact = async (record: any, index: number) => {
    const key = `${record.source_schema || record._typed_table || "record"}-${record.latest_parsed_id || record.id || index}`;
    setContacting(key);
    try {
      const result = await api.resolveBrokerContact(
        Number(record.latest_parsed_id || record.id),
        record.source_schema || record._typed_table,
        record.latest_raw_message_id || record.raw_message_id,
      );
      window.open(result.contact_url, "_blank", "noopener,noreferrer");
    } catch {
      setToast({ tone: "error", message: "WhatsApp contact is not available for this record." });
    } finally {
      setContacting(null);
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
  const listings = building.listings ?? [];
  const requirements = building.requirements ?? [];
  const price_stats = building.price_stats ?? [];

  return (
    <div className="relative space-y-6">
      {toast && <div role="status" className={`fixed right-6 top-6 z-50 max-w-sm rounded-xl border px-4 py-3 shadow-2xl ${toast.tone === "success" ? "border-[#00ff88]/30 bg-[#10251b] text-emerald-100" : "border-red-300/30 bg-[#2a1418] text-red-100"}`}>
        <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#00ff88]">PropAI</div>
        <div className="mt-1 text-sm">{toast.message}</div>
        <button type="button" onClick={() => setToast(null)} className="mt-2 text-xs font-semibold underline underline-offset-2">Dismiss</button>
      </div>}
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <button
            onClick={() => router.push("/buildings")}
            className="text-zinc-500 text-xs mb-2 hover:text-white"
          >
            ← Back to Buildings
          </button>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-emerald-300">Building opportunity</div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">{b.canonical_name}</h1>
          <div className="mt-1 text-sm text-zinc-400">{b.micro_market || "Market not confirmed"} <span className="mx-1 text-zinc-700">·</span> {b.observed_listings || listings.length} market opportunities</div>
        </div>
      </div>

      {/* Building Info */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
            <h3 className="text-sm font-semibold mb-1 text-white">Available opportunities ({listings.length})</h3>
            <p className="text-xs text-zinc-500">Captured from market messages. Contact the broker directly when the opportunity fits your client.</p>
          </div>
        </div>
        {listings.length === 0 ? <div className="mt-3 rounded-lg border border-white/10 bg-[#0a0f14] p-4 text-xs text-zinc-500">No listing records are linked yet.</div> : <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-white/[0.03] text-left text-[10px] uppercase tracking-wider text-zinc-500">
              <tr><th className="px-3 py-2">Opportunity</th><th className="px-3 py-2">Intent</th><th className="px-3 py-2">BHK</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Action</th></tr>
            </thead>
            <tbody>{listings.map((listing: any, index: number) => { const contactKey = `${listing.source_schema || listing._typed_table || "record"}-${listing.latest_parsed_id || listing.id || index}`; return <tr key={contactKey} className="border-t border-white/10 align-top">
              <td className="px-3 py-2 text-white">{(() => { const href = marketRecordHref(listing, listing.summary_title); return href ? <Link href={href} className="font-medium text-emerald-300 hover:underline">{listing.summary_title || listing.property_type || "Parsed listing"}</Link> : (listing.summary_title || listing.property_type || "Parsed listing"); })()}</td>
              <td className="px-3 py-2 text-zinc-300">{listing.transaction_type || "—"}</td>
              <td className="px-3 py-2 text-zinc-300">{listing.bhk || "—"}</td>
              <td className="px-3 py-2 font-mono text-emerald-200">{formatPrice(Number(listing.price || 0))}</td>
              <td className="px-3 py-2 text-zinc-400">Captured WhatsApp</td>
              <td className="px-3 py-2 text-zinc-500">{listing.last_seen ? new Date(listing.last_seen).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</td>
              <td className="px-3 py-2"><div className="flex items-center gap-3">{marketRecordHref(listing, listing.summary_title) ? <Link href={marketRecordHref(listing, listing.summary_title) as string} className="text-emerald-300 hover:underline">Open evidence</Link> : <span className="text-zinc-600">Unavailable</span>}<button type="button" onClick={() => handleContact(listing, index)} disabled={contacting === contactKey} className="whitespace-nowrap rounded-md bg-[#00ff88] px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-[#7dffba] disabled:cursor-wait disabled:opacity-50">{contacting === contactKey ? "Opening…" : "WhatsApp"}</button></div></td>
            </tr>; })}</tbody>
          </table>
        </div>}
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold mb-1 text-white">Client demand ({requirements.length})</h3>
            <p className="text-xs text-zinc-500">Buyer and tenant requirements connected to this building.</p>
          </div>
        </div>
        {requirements.length === 0 ? <div className="mt-3 rounded-lg border border-white/10 bg-[#0a0f14] p-4 text-xs text-zinc-500">No requirement records are linked yet.</div> : <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[760px] text-xs">
            <thead className="bg-white/[0.03] text-left text-[10px] uppercase tracking-wider text-zinc-500"><tr><th className="px-3 py-2">Requirement</th><th className="px-3 py-2">Intent</th><th className="px-3 py-2">Budget</th><th className="px-3 py-2">Broker</th><th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Evidence</th></tr></thead>
            <tbody>{requirements.map((requirement: any, index: number) => { const href = marketRecordHref(requirement, requirement.summary_title); const contactKey = `${requirement.source_schema || requirement._typed_table || "record"}-${requirement.latest_parsed_id || requirement.id || index}`; return <tr key={contactKey} className="border-t border-white/10 align-top"><td className="px-3 py-2 text-white">{href ? <Link href={href} className="font-medium text-emerald-300 hover:underline">{requirement.summary_title || "Parsed requirement"}</Link> : (requirement.summary_title || "Parsed requirement")}</td><td className="px-3 py-2 text-zinc-300">{requirement.transaction_type || "—"}</td><td className="px-3 py-2 font-mono text-emerald-200">{formatPrice(Number(requirement.price || requirement.budget_max || 0))}</td><td className="px-3 py-2 text-zinc-300">{requirement.broker_name || "—"}</td><td className="px-3 py-2 text-zinc-500">{requirement.last_seen ? new Date(requirement.last_seen).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—"}</td><td className="px-3 py-2"><div className="flex items-center gap-3">{href ? <Link href={href} className="text-emerald-300 hover:underline">Open evidence</Link> : <span className="text-zinc-600">Unavailable</span>}<button type="button" onClick={() => handleContact(requirement, index)} disabled={contacting === contactKey} className="whitespace-nowrap rounded-md bg-[#00ff88] px-2.5 py-1 text-[11px] font-semibold text-black hover:bg-[#7dffba] disabled:cursor-wait disabled:opacity-50">{contacting === contactKey ? "Opening…" : "WhatsApp"}</button></div></td></tr>; })}</tbody>
          </table>
        </div>}
      </div>

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

      <hr className="border-zinc-800" />
      <NotesPanel entityType="building" entityId={building_id} />
    </div>
  );
}

function InfoCard({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="min-w-0 bg-[#0a0f14] border border-white/10 rounded-lg p-3">
      <div className="text-[11px] text-zinc-500 uppercase">{label}</div>
      <div className={`mt-1 break-words whitespace-normal text-sm font-semibold ${accent ? "text-[#00ff88]" : "text-white"}`}>
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
