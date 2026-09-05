"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowUpRight, Building2, ChevronRight, MapPin, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";

type Building = {
  id: number | string;
  building_id?: string;
  canonical_name?: string;
  micro_market?: string;
  developer?: string;
  observed_listings?: number;
  observed_brokers?: number;
  alias_count?: number;
  last_enriched?: string | null;
  status?: string;
};

export default function BuildingsPage() {
  const router = useRouter();
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const buildingData = await api.getBuildings(100, 0);
      setBuildings(buildingData.buildings || []);
      setLoadError(null);
    } catch (error) {
      console.error("Failed to load buildings", error);
      setLoadError("Buildings could not be loaded from the workspace API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);


  const filteredBuildings = useMemo(() => {
    const search = filter.trim().toLowerCase();
    if (!search) return buildings;
    return buildings.filter((building) => [building.canonical_name, building.micro_market, building.developer, building.building_id].some((value) => String(value || "").toLowerCase().includes(search)));
  }, [buildings, filter]);

  const activeBuildings = useMemo(() => [...filteredBuildings].sort((a, b) => Number(b.observed_listings || 0) - Number(a.observed_listings || 0)).slice(0, 6), [filteredBuildings]);
  const marketCoverage = useMemo(() => {
    const grouped = new Map<string, { listings: number; buildings: number }>();
    filteredBuildings.forEach((building) => {
      const market = building.micro_market || "Market not resolved";
      const current = grouped.get(market) || { listings: 0, buildings: 0 };
      current.listings += Number(building.observed_listings || 0);
      current.buildings += 1;
      grouped.set(market, current);
    });
    return [...grouped.entries()].sort((a, b) => b[1].listings - a[1].listings).slice(0, 5);
  }, [filteredBuildings]);
  const needsAttention = useMemo(() => filteredBuildings.filter((building) => !building.last_enriched || building.status === "discovered").slice(0, 3), [filteredBuildings]);
  const buildingColumns = useMemo<DataTableColumn<Building>[]>(() => [
    { id: "building", header: "Building", accessor: (row) => row.canonical_name, sortable: true, cell: (row) => <><div className="font-medium text-[var(--foreground)]">{row.canonical_name || "Unnamed building"}</div><div className="mt-1 font-mono text-[10px] text-[var(--text-secondary)]">{row.building_id}</div></> },
    { id: "market", header: "Market", accessor: (row) => row.micro_market || "Not resolved", sortable: true, cell: (row) => <span className="text-[var(--text-secondary)]">{row.micro_market || "Not resolved"}</span> },
    { id: "listings", header: "Listings", accessor: (row) => Number(row.observed_listings || 0), sortable: true, cell: (row) => <span className="font-medium tabular-nums">{row.observed_listings || 0}</span> },
    { id: "brokers", header: "Brokers", accessor: (row) => Number(row.observed_brokers || 0), sortable: true, cell: (row) => <span className="text-[var(--text-secondary)]">{row.observed_brokers || 0}</span> },
    { id: "aliases", header: "Aliases", accessor: (row) => Number(row.alias_count || 0), sortable: true, cell: (row) => <span className="text-[var(--text-secondary)]">{row.alias_count || 0}</span> },
    { id: "state", header: "State", accessor: (row) => row.status || "", cell: (row) => <StateBadge building={row} /> },
  ], []);

  return (
    <div className="buildings-page min-w-0 space-y-7 p-1 sm:p-0">
      <header className="flex flex-col gap-5 border-b border-[var(--line)] pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div><p className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--monsoon-teal)]">Market workspace</p><h1 className="mt-2 text-2xl font-semibold leading-tight tracking-[-0.03em] text-[var(--foreground)] sm:text-3xl sm:tracking-tight">Buildings with activity</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--text-secondary)]">Browse the buildings where your broker network is seeing real property opportunities.</p></div>
      </header>

      {toast && <div role="status" className={`propai-toast fixed right-6 top-6 z-50 flex max-w-sm items-start gap-3 rounded-xl border px-4 py-3 shadow-2xl ${toast.tone === "success" ? "propai-toast-success" : "propai-toast-error"}`}><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><div className="flex-1 text-sm">{toast.message}</div><button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification"><X className="h-4 w-4" /></button></div>}
      {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--alert-vermilion)]/40 bg-[var(--alert-vermilion)]/10 px-4 py-3 text-sm text-[var(--foreground)]"><span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 text-[var(--alert-vermilion)]" />{loadError}</span><Button variant="outline" size="sm" onClick={() => { setLoading(true); void loadData(); }}>Retry</Button></div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold text-[var(--foreground)]">Explore your market</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Open a building to compare available opportunities and contact the source broker.</p></div></div>

      {loading ? <BuildingSkeleton /> : filteredBuildings.length === 0 ? <EmptyState hasFilter={Boolean(filter)} /> : <>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,.75fr)]">
          <section className="overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--ink-2)]"><div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><div><h3 className="text-sm font-semibold text-[var(--mist)]">Most active buildings</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">Ranked by captured listings</p></div><span className="text-xs text-[var(--text-secondary)]">{filteredBuildings.length} in view</span></div><div className="divide-y divide-[var(--line)]">{activeBuildings.map((building, index) => <BuildingRow key={building.id} building={building} rank={index + 1} onOpen={() => router.push(`/buildings/${building.building_id}`)} />)}</div></section>
          <section className="rounded-2xl border border-[var(--line)] bg-[var(--ink-2)] p-5"><div className="flex items-start justify-between"><div><h3 className="text-sm font-semibold text-[var(--mist)]">Market coverage</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">Listings grouped by locality</p></div><MapPin className="h-4 w-4 text-[var(--monsoon-teal)]" /></div><div className="mt-5 space-y-4">{marketCoverage.map(([market, coverage]) => <MarketRow key={market} market={market} {...coverage} />)}</div></section>
        </div>

        <section className="rounded-2xl border border-[var(--line)] bg-[var(--ink-2)] p-5"><div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"><div><h3 className="text-sm font-semibold text-[var(--mist)]">Needs attention</h3><p className="mt-1 text-xs text-[var(--text-secondary)]">Records that are still being grounded or enriched.</p></div><div className="relative w-full lg:w-80"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--monsoon-teal)]" /><input aria-label="Search buildings" type="text" placeholder="Search building or market" value={filter} onChange={(event) => setFilter(event.target.value)} className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--ink)] pl-9 pr-3 text-sm text-[var(--mist)] outline-none placeholder:text-[var(--text-secondary)] focus:border-[var(--monsoon-teal)]" /></div></div>{needsAttention.length > 0 ? <div className="mt-5 grid gap-3 md:grid-cols-3">{needsAttention.map((building) => <AttentionRow key={building.id} building={building} onOpen={() => router.push(`/buildings/${building.building_id}`)} />)}</div> : <p className="mt-5 text-sm text-[var(--text-secondary)]">No unresolved building records in this view.</p>}</section>

        <details className="group rounded-2xl border border-[var(--line)] bg-[var(--ink-2)]"><summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-semibold text-[var(--mist)]"><span>All buildings <span className="ml-2 text-xs font-normal text-[var(--text-secondary)]">{filteredBuildings.length} records</span></span><ChevronRight className="h-4 w-4 text-[var(--text-secondary)] transition-transform group-open:rotate-90" /></summary><div className="border-t border-[var(--line)] p-4"><DataTable columns={buildingColumns} data={filteredBuildings} getRowId={(row) => String(row.id)} onRowClick={(row) => router.push(`/buildings/${row.building_id}`)} pageSize={10} footerLabel={`${filteredBuildings.length} buildings in this view`} toolbar={<span className="text-xs text-[var(--text-secondary)]">Sort and page through the building directory</span>} /></div></details>
      </>}
    </div>
  );
}

function BuildingRow({ building, rank, onOpen }: { building: Building; rank: number; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--monsoon-teal)]/[0.05]"><span className="w-5 font-mono text-xs text-[var(--text-secondary)]">0{rank}</span><span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--monsoon-teal)]/10 text-[var(--monsoon-teal)]"><Building2 className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate font-medium text-[var(--mist)]">{building.canonical_name || "Unnamed building"}</span><span className="mt-1 flex items-center gap-1 truncate text-xs text-[var(--text-secondary)]"><MapPin className="h-3 w-3" />{building.micro_market || "Market not resolved"}</span></span><span className="hidden text-right sm:block"><span className="block font-semibold tabular-nums text-[var(--mist)]">{building.observed_listings || 0}</span><span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">listings</span></span><span className="hidden text-right md:block"><span className="block font-semibold tabular-nums text-[var(--mist)]">{building.observed_brokers || 0}</span><span className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">brokers</span></span><ChevronRight className="h-4 w-4 text-[var(--text-secondary)]" /></button>;
}

function MarketRow({ market, listings, buildings }: { market: string; listings: number; buildings: number }) {
  return <div><div className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-[var(--mist)]">{market}</span><span className="shrink-0 font-medium tabular-nums text-[var(--mist)]">{listings}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--ink)]"><div className="h-full rounded-full bg-[var(--monsoon-teal)]" style={{ width: `${Math.min(100, Math.max(8, listings / Math.max(1, buildings) * 6))}%` }} /></div><p className="mt-1 text-[10px] text-[var(--text-secondary)]">{buildings} {buildings === 1 ? "building" : "buildings"}</p></div>;
}

function AttentionRow({ building, onOpen }: { building: Building; onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--ink)] p-4 text-left transition-colors hover:border-[var(--monsoon-teal)]/60"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--taxi-amber)]/10 text-[var(--taxi-amber)]"><AlertCircle className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-[var(--mist)]">{building.canonical_name || "Unnamed building"}</span><span className="mt-1 block truncate text-xs text-[var(--text-secondary)]">{building.last_enriched ? "Review discovered state" : "Not enriched yet"}</span></span><ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" /></button>;
}

function StateBadge({ building }: { building: Building }) {
  const ready = Boolean(building.last_enriched) && building.status !== "discovered";
  return <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-medium ${ready ? "bg-[var(--signal-lime)]/10 text-[var(--signal-lime)]" : "bg-[var(--taxi-amber)]/10 text-[var(--taxi-amber)]"}`}>{ready ? "Grounded" : "Needs review"}</span>;
}

function BuildingSkeleton() { return <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(280px,.75fr)]"><div className="h-80 animate-pulse rounded-2xl bg-[var(--ink-2)]" /><div className="h-80 animate-pulse rounded-2xl bg-[var(--ink-2)]" /></div>; }

function EmptyState({ hasFilter }: { hasFilter: boolean }) {
  return <div className="rounded-2xl border border-[var(--line)] bg-[var(--ink-2)] px-6 py-16 text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[var(--monsoon-teal)]/40 bg-[var(--monsoon-teal)]/10 text-[var(--monsoon-teal)]"><Building2 className="h-7 w-7" /></div><h2 className="mt-5 text-lg font-semibold text-[var(--mist)]">{hasFilter ? "No buildings match this search" : "No building activity yet"}</h2><p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--text-secondary)]">{hasFilter ? "Try a different building name, developer, or market." : "Buildings will appear here when captured market activity is available."}</p></div>;
}
