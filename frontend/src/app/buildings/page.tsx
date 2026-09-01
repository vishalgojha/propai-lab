"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";
import { AlertCircle, Building2, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function BuildingsPage() {
  const router = useRouter();
  const [buildings, setBuildings] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [refreshingCounts, setRefreshingCounts] = useState(false);
  const [filter, setFilter] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [bldData, dashData] = await Promise.all([
        api.getBuildings(100, 0),
        api.getBuildingEnrichmentDashboard(),
      ]);
      setBuildings(bldData.buildings || []);
      setStats(dashData);
      setLoadError(null);
    } catch (e) {
      console.error("Failed to load buildings", e);
      setLoadError("Buildings could not be loaded from the workspace API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const result = await api.discoverBuildings();
      setToast({ tone: "success", message: `Discovery complete · ${result.discovered} buildings found` });
      await loadData();
    } catch (e) {
      setToast({ tone: "error", message: "Discovery failed · the workspace API did not respond" });
    } finally {
      setDiscovering(false);
    }
  };

  const handleRefreshCounts = async () => {
    setRefreshingCounts(true);
    try {
      const result = await api.refreshBuildingCounts();
      setToast({ tone: "success", message: `Counts refreshed · ${result.with_listings} buildings have listings` });
      await loadData();
    } catch (e) {
      setToast({ tone: "error", message: "Count refresh failed · try again in a moment" });
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
    <div className="buildings-page min-w-0 space-y-6 p-1 sm:p-0">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><div className="eyebrow-label">Entity workspace</div><h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--mist)]">Buildings</h1><p className="mt-2 max-w-xl text-sm leading-relaxed text-[var(--text-secondary)]">Grounded building records, aliases, and enrichment status from the broker network.</p></div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button variant="outline" size="sm"
            onClick={handleRefreshCounts}
            disabled={refreshingCounts}
          >
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${refreshingCounts ? "animate-spin" : ""}`} />{refreshingCounts ? "Refreshing" : "Refresh counts"}
          </Button>
          <Button size="sm"
            onClick={handleDiscover}
            disabled={discovering}
          >
            <Sparkles className="mr-2 h-3.5 w-3.5" />{discovering ? "Discovering" : "Discover buildings"}
          </Button>
          <Button variant="ghost" size="sm"
            onClick={() => router.push("/buildings/enrichment")}
          >
            Enrichment dashboard
          </Button>
        </div>
      </div>

      {toast && <div role="status" className={`propai-toast fixed right-6 top-6 z-50 flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-2xl ${toast.tone === "success" ? "propai-toast-success" : "propai-toast-error"}`}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><div className="flex-1 text-sm">{toast.message}</div><button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification"><X className="h-4 w-4" /></button></div>}
      {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--alert-vermilion)]/40 bg-[var(--alert-vermilion)]/10 px-4 py-3 text-sm text-[var(--mist)]"><span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 text-[var(--alert-vermilion)]" />{loadError}</span><Button variant="outline" size="sm" onClick={() => { setLoading(true); void loadData(); }}>Retry</Button></div>}

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
      <Card className="buildings-toolbar">
        <CardContent className="flex items-center gap-3 p-3">
          <Search className="h-4 w-4 shrink-0 text-[var(--monsoon-teal)]" />
          <input type="text" placeholder="Search by building, market, developer, or ID" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-full bg-transparent text-sm text-[var(--mist)] outline-none placeholder:text-[var(--text-secondary)]" />
          <span className="hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-[var(--text-secondary)] sm:inline">{filteredBuildings.length} visible</span>
        </CardContent>
      </Card>

      {/* Buildings Table */}
      {loading ? (
        <div className="text-zinc-500">Loading buildings...</div>
      ) : filteredBuildings.length === 0 ? (
        <Card className="buildings-empty-state">
          <CardContent className="flex flex-col items-center px-6 py-16 text-center">
            <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-[var(--monsoon-teal)]/40 bg-[var(--monsoon-teal)]/10 text-[var(--monsoon-teal)]"><Building2 className="h-7 w-7" /></div>
            <h2 className="text-lg font-semibold text-[var(--mist)]">No grounded buildings yet</h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">Discover building names from captured observations, then review their aliases and enrichment status here.</p>
            <Button className="mt-6" size="sm" onClick={handleDiscover} disabled={discovering}><Sparkles className="mr-2 h-3.5 w-3.5" />{discovering ? "Discovering" : "Discover buildings"}</Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="buildings-table-card overflow-hidden">
          <CardHeader className="border-b border-[var(--line)] px-4 py-4"><CardTitle className="text-sm">Building directory</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto p-0">
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="buildings-stat-card rounded-xl border border-[var(--line)] bg-[var(--ink-2)] p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-[var(--mist)]">{value || 0}</div>
    </div>
  );
}
