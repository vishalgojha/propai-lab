"use client";

import { useEffect, useState, useCallback } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";

export default function BuildingEnrichmentDashboardPage() {
  const router = useRouter();
  const [stats, setStats] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [jobFilter, setJobFilter] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [dashData, jobsData, histData] = await Promise.all([
        api.getBuildingEnrichmentDashboard(),
        api.getBuildingEnrichmentJobs(undefined, 100),
        api.getBuildingEnrichmentHistory(undefined, 100),
      ]);
      setStats(dashData);
      setJobs(jobsData);
      setHistory(histData);
    } catch (e) {
      console.error("Failed to load enrichment dashboard", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const filteredJobs = jobs.filter(j => {
    if (!jobFilter) return true;
    return j.status === jobFilter;
  });

  if (loading) {
    return <div className="text-zinc-500">Loading enrichment dashboard...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <button
            onClick={() => router.push("/buildings")}
            className="text-zinc-500 text-xs mb-2 hover:text-white"
          >
            ← Back to Buildings
          </button>
          <h1 className="text-xl font-bold">Building Enrichment Dashboard</h1>
        </div>
        <button
          onClick={loadData}
          className="border border-white/10 text-zinc-500 px-3 py-1.5 text-xs rounded hover:bg-zinc-900"
        >
          Refresh
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <StatCard label="Total Buildings" value={stats.total_buildings} />
          <StatCard label="Enriched" value={stats.buildings_enriched} accent />
          <StatCard label="Pending Jobs" value={stats.pending_jobs} />
          <StatCard label="Running Jobs" value={stats.running_jobs} accent />
          <StatCard label="Completed Jobs" value={stats.completed_jobs} />
          <StatCard label="Failed Jobs" value={stats.failed_jobs} warning />
        </div>
      )}

      {/* Provider Stats */}
      {stats && stats.by_provider && stats.by_provider.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Provider Performance</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {stats.by_provider.map((p: any, i: number) => (
              <div key={i} className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
                <div className="font-semibold text-sm capitalize">{p.provider}</div>
                <div className="mt-2 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Jobs</span>
                    <span>{p.jobs}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Enriched</span>
                    <span className="text-[#00ff88]">{p.enriched}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Failed</span>
                    <span className="text-[#ff6b35]">{p.failed}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-zinc-500">Avg Confidence</span>
                    <span>{p.avg_confidence ? `${(p.avg_confidence * 100).toFixed(0)}%` : "—"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending Jobs */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Enrichment Jobs</h3>
          <div className="flex gap-2">
            {["", "pending", "running", "completed", "failed"].map(status => (
              <button
                key={status}
                onClick={() => setJobFilter(status)}
                className={`text-xs px-2 py-1 rounded ${
                  jobFilter === status
                    ? "bg-[#00ff88] text-black"
                    : "bg-[rgba(255,255,255,0.06)] text-zinc-500 hover:bg-[rgba(255,255,255,0.1)]"
                }`}
              >
                {status || "All"}
              </button>
            ))}
          </div>
        </div>
        {filteredJobs.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">No jobs found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">ID</th>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Building</th>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Provider</th>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Status</th>
                  <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Priority</th>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Created</th>
                  <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Error</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.slice(0, 50).map((j: any) => (
                  <tr
                    key={j.id}
                    className="hover:bg-zinc-900 cursor-pointer"
                    onClick={() => router.push(`/buildings/${j.building_code}`)}
                  >
                    <td className="px-2.5 py-2 border-b border-white/10 font-mono text-xs">{j.id}</td>
                    <td className="px-2.5 py-2 border-b border-white/10">
                      <div className="font-semibold text-sm">{j.canonical_name}</div>
                      <div className="text-zinc-500 text-xs font-mono">{j.building_code}</div>
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/10 capitalize">{j.provider}</td>
                    <td className="px-2.5 py-2 border-b border-white/10">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right">{j.priority}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-xs text-zinc-500">{j.created_at}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-xs text-[#ff6b35] max-w-[200px] truncate">
                      {j.error || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Enrichment History */}
      {history.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2">Recent Enrichment History</h3>
          <div className="space-y-2">
            {history.slice(0, 30).map((h: any, i: number) => (
              <div key={i} className="bg-[#0a0f14] border border-white/10 rounded p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold">{h.canonical_name}</span>
                    <span className="text-zinc-500 ml-2 font-mono text-xs">{h.building_code}</span>
                  </div>
                  <StatusBadge status={h.status} />
                </div>
                <div className="flex items-center gap-4 mt-1 text-xs text-zinc-500">
                  <span className="capitalize">{h.provider}</span>
                  {h.fields_updated && (
                    <span>Fields: {Array.isArray(h.fields_updated) ? h.fields_updated.join(", ") : h.fields_updated}</span>
                  )}
                  {h.confidence && (
                    <span>Confidence: {(h.confidence * 100).toFixed(0)}%</span>
                  )}
                  <span>{h.created_at}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent, warning }: { label: string; value: number; accent?: boolean; warning?: boolean }) {
  return (
    <div className="bg-[#0a0f14] border border-white/10 rounded-lg p-3">
      <div className="text-[11px] text-zinc-500 uppercase">{label}</div>
      <div className={`text-xl font-bold mt-1 ${accent ? "text-[#00ff88]" : warning ? "text-[#ff6b35]" : "text-white"}`}>
        {value || 0}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-[rgba(255,255,255,0.1)] text-zinc-500",
    running: "bg-[#00ff88]/10 text-[#00ff88]",
    completed: "bg-[#00ff88]/10 text-[#00ff88]",
    enriched: "bg-[#00ff88]/10 text-[#00ff88]",
    failed: "bg-[#ff6b35]/10 text-[#ff6b35]",
    needs_review: "bg-[#ffd700]/10 text-[#ffd700]",
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded ${colors[status] || "bg-[rgba(255,255,255,0.1)] text-zinc-500"}`}>
      {status}
    </span>
  );
}
