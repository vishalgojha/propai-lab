"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";

export default function BuildingsPage() {
  const router = useRouter();
  const [buildings, setBuildings] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [refreshingCounts, setRefreshingCounts] = useState(false);
  const [filter, setFilter] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [bldData, dashData] = await Promise.all([
        api.getBuildings(100, 0),
        api.getBuildingEnrichmentDashboard(),
      ]);
      setBuildings(bldData.buildings || []);
      setStats(dashData);
    } catch (e) {
      console.error("Failed to load buildings", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const result = await api.discoverBuildings();
      alert(`Discovered ${result.discovered} buildings (${result.new} new, ${result.existing} existing)`);
      loadData();
    } catch (e) {
      alert("Discovery failed");
    } finally {
      setDiscovering(false);
    }
  };

  const handleRefreshCounts = async () => {
    setRefreshingCounts(true);
    try {
      const result = await api.refreshBuildingCounts();
      alert(`Refreshed counts: ${result.with_listings} buildings with listings out of ${result.total_buildings} total`);
      loadData();
    } catch (e) {
      alert("Refresh failed");
    } finally {
      setRefreshingCounts(false);
    }
  };

  const filteredBuildings = buildings.filter(b => {
    if (!filter) return true;
    const search = filter.toLowerCase();
    return (b.canonical_name || "").toLowerCase().includes(search) ||
           (b.micro_market || "").toLowerCase().includes(search) ||
           (b.developer || "").toLowerCase().includes(search) ||
           (b.building_id || "").toLowerCase().includes(search);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Buildings</h1>
        <div className="flex gap-2">
          <button
            onClick={handleRefreshCounts}
            disabled={refreshingCounts}
            className="bg-[#58a6ff] text-white px-3 py-1.5 text-xs font-semibold rounded hover:bg-[#4090e0] disabled:opacity-50"
          >
            {refreshingCounts ? "Refreshing..." : "Refresh Counts"}
          </button>
          <button
            onClick={handleDiscover}
            disabled={discovering}
            className="bg-[#00ff88] text-black px-3 py-1.5 text-xs font-semibold rounded hover:bg-[#00cc6a] disabled:opacity-50"
          >
            {discovering ? "Discovering..." : "Discover Buildings"}
          </button>
          <button
            onClick={() => router.push("/buildings/enrichment")}
            className="border border-white/10 text-zinc-500 px-3 py-1.5 text-xs rounded hover:bg-zinc-900"
          >
            Enrichment Dashboard
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label="Total Buildings" value={stats.total_buildings} />
          <StatCard label="With Aliases" value={stats.buildings_with_aliases} />
          <StatCard label="Enriched" value={stats.buildings_enriched} />
          <StatCard label="Pending Jobs" value={stats.pending_jobs} />
          <StatCard label="Failed Jobs" value={stats.failed_jobs} />
        </div>
      )}

      {/* Search */}
      <input
        type="text"
        placeholder="Search buildings by name, market, developer, or ID..."
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="w-full bg-[#0a0f14] border border-white/10 rounded px-3 py-2 text-sm text-white placeholder:text-zinc-500"
      />

      {/* Buildings Table */}
      {loading ? (
        <div className="text-zinc-500">Loading buildings...</div>
      ) : filteredBuildings.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <div className="text-4xl mb-2">🏢</div>
          <p>No buildings found. Click &quot;Discover Buildings&quot; to extract from observations.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">ID</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Market</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Developer</th>
                <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Listings</th>
                <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Brokers</th>
                <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Aliases</th>
                <th className="text-center px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Enriched</th>
                <th className="text-center px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredBuildings.map((b) => (
                <tr
                  key={b.id}
                  className="hover:bg-zinc-900 cursor-pointer"
                  onClick={() => router.push(`/buildings/${b.building_id}`)}
                >
                  <td className="px-2.5 py-2 border-b border-white/10 font-mono text-xs text-zinc-500">{b.building_id}</td>
                  <td className="px-2.5 py-2 border-b border-white/10 font-semibold">{b.canonical_name}</td>
                  <td className="px-2.5 py-2 border-b border-white/10">{b.micro_market || "—"}</td>
                  <td className="px-2.5 py-2 border-b border-white/10">{b.developer || "—"}</td>
                  <td className="px-2.5 py-2 border-b border-white/10 text-right">{b.observed_listings}</td>
                  <td className="px-2.5 py-2 border-b border-white/10 text-right">{b.observed_brokers}</td>
                  <td className="px-2.5 py-2 border-b border-white/10 text-right text-zinc-500">{b.alias_count || 0}</td>
                  <td className="px-2.5 py-2 border-b border-white/10 text-center">
                    {b.last_enriched ? (
                      <span className="text-[#00ff88]">✓</span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="px-2.5 py-2 border-b border-white/10 text-center">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      b.status === "active" ? "bg-[#00ff88]/10 text-[#00ff88]" :
                      b.status === "inactive" ? "bg-[#ff6b35]/10 text-[#ff6b35]" :
                      "bg-[rgba(255,255,255,0.1)] text-zinc-500"
                    }`}>
                      {b.status || "unknown"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
      <div className="text-[11px] text-zinc-500 uppercase">{label}</div>
      <div className="text-xl font-bold mt-1">{value || 0}</div>
    </div>
  );
}
