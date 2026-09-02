"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createCrmInventory,
  getCrmInventory,
  importCrmInventory,
  updateCrmInventory,
  type CrmInventoryItem,
} from "@/lib/api";

const stages = ["New", "Follow up", "Viewing", "Negotiation", "Closed"] as const;
type Stage = typeof stages[number];

function stageOf(row: CrmInventoryItem): Stage {
  const value = String(row.custom_fields?.workflow_stage || "");
  return stages.includes(value as Stage) ? value as Stage : "New";
}

function dueOf(row: CrmInventoryItem) {
  const date = String(row.custom_fields?.follow_up_date || "");
  return Boolean(date && date <= new Date().toISOString().slice(0, 10) && stageOf(row) !== "Closed");
}

function titleOf(row: CrmInventoryItem) {
  return row.building_name?.trim() || row.location?.trim() || "Untitled property";
}

function shareUrl(row: CrmInventoryItem) {
  const summary = [
    titleOf(row),
    row.location,
    row.bhk && `${row.bhk} BHK`,
    row.area_sqft && `${row.area_sqft} sq ft`,
    row.quote,
  ].filter(Boolean).join(" · ");
  return `https://wa.me/?text=${encodeURIComponent(`Hi, sharing this property with you:\n${summary}`)}`;
}

export default function CrmWorkspace() {
  const [rows, setRows] = useState<CrmInventoryItem[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"pipeline" | "records">("pipeline");
  const [stageFilter, setStageFilter] = useState<Stage | "all">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try {
      setRows(await getCrmInventory(query));
      setError("");
    } catch {
      setError("Private inventory could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [query]);

  const visibleRows = useMemo(() => rows.filter(row => stageFilter === "all" || stageOf(row) === stageFilter), [rows, stageFilter]);
  const dueCount = useMemo(() => rows.filter(dueOf).length, [rows]);
  const activeCount = useMemo(() => rows.filter(row => !["New", "Closed"].includes(stageOf(row))).length, [rows]);
  const grouped = useMemo(() => stages.map(stage => ({ stage, rows: visibleRows.filter(row => stageOf(row) === stage) })), [visibleRows]);

  async function addRow() {
    setBusy(true);
    try {
      const row = await createCrmInventory({ building_name: "New property", location: "", custom_fields: {} });
      setRows(current => [row, ...current]);
      setView("records");
      setMessage("New private record added. Complete the details below.");
    } catch {
      setError("The private record could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function move(row: CrmInventoryItem, stage: Stage) {
    try {
      const saved = await updateCrmInventory(row.id, { custom_fields: { ...(row.custom_fields || {}), workflow_stage: stage } });
      setRows(current => current.map(item => item.id === saved.id ? saved : item));
    } catch {
      setError("The stage could not be saved.");
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const result = await importCrmInventory(file);
      setMessage(`${result.imported} private records imported${result.rejected.length ? ` · ${result.rejected.length} skipped` : ""}.`);
      await load();
    } catch {
      setError("That file could not be imported. Use CSV, TSV, JSON, or Excel.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return <main className="min-h-[calc(100vh-5rem)] bg-[var(--bg-base)] px-4 py-6 text-[var(--text-primary)] sm:px-6 lg:px-10">
    <div className="mx-auto max-w-[1500px]">
      <header className="flex flex-col gap-5 border-b border-[var(--border-subtle)] pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--signal-dim)]">Private workspace</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">CRM workspace</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">Turn broker notes into a private pipeline, keep the next action visible, and share only the properties you choose.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void addRow()} disabled={busy} className="rounded-lg bg-[var(--signal-dim)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Add property</button>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.json,.xlsx,.xls" className="hidden" onChange={event => void importFile(event.target.files?.[0])} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-lg border border-[var(--border-strong)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Import sheet</button>
          <a href="/chat" className="rounded-lg border border-[var(--border-strong)] px-4 py-2.5 text-sm font-semibold">Add from chat</a>
        </div>
      </header>

      <section className="mt-5 grid gap-3 sm:grid-cols-3">
        {["Total records", "Needs follow-up", "Active pipeline"].map((label, index) => {
          const value = loading ? null : [rows.length, dueCount, activeCount][index];
          return <div key={label} className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{label}</p>{value === null ? <div className="mt-3 h-7 w-16 animate-pulse rounded bg-[var(--border-subtle)]" /> : <p className="mt-2 text-2xl font-semibold">{value}</p>}</div>;
        })}
      </section>

      <section className="mt-5 flex flex-col gap-3 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-lg bg-[var(--bg-base)] p-1"><button type="button" onClick={() => setView("pipeline")} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === "pipeline" ? "bg-[var(--signal-dim)] text-white" : "text-[var(--text-secondary)]"}`}>Pipeline</button><button type="button" onClick={() => setView("records")} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === "records" ? "bg-[var(--signal-dim)] text-white" : "text-[var(--text-secondary)]"}`}>All records</button></div>
        <label className="block w-full sm:max-w-sm"><span className="sr-only">Search private records</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search properties, locations, or contacts" className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]" /></label>
      </section>

      {message && <p role="status" className="mt-4 rounded-lg border border-[var(--signal-dim)]/40 bg-[var(--signal-dim)]/10 px-4 py-3 text-sm">{message}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-[var(--amber)]/40 bg-[var(--amber)]/10 px-4 py-3 text-sm">{error}</p>}

      {view === "pipeline" ? <section className="mt-6"><div className="mb-4 flex flex-wrap gap-2">{["all", ...stages].map(stage => <button type="button" key={stage} onClick={() => setStageFilter(stage as Stage | "all")} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${stageFilter === stage ? "border-[var(--signal-dim)] bg-[var(--signal-dim)]/15 text-[var(--signal-dim)]" : "border-[var(--border-subtle)] text-[var(--text-secondary)]"}`}>{stage === "all" ? "All stages" : stage}</button>)}</div><div className="grid gap-4 overflow-x-auto pb-3 md:grid-cols-2 xl:grid-cols-5">{grouped.map(group => <div key={group.stage} className="min-w-[245px] rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)]"><div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-3"><h2 className="text-sm font-semibold">{group.stage}</h2><span className="text-xs text-[var(--text-secondary)]">{group.rows.length}</span></div><div className="space-y-2 p-2">{loading ? <><div className="h-28 animate-pulse rounded-lg bg-[var(--border-subtle)]" /><div className="h-24 animate-pulse rounded-lg bg-[var(--border-subtle)]" /></> : group.rows.length === 0 ? <p className="px-2 py-6 text-center text-xs text-[var(--text-secondary)]">No records here</p> : group.rows.slice(0, 20).map(row => <article key={row.id} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3"><div className="flex items-start justify-between gap-2"><h3 className="min-w-0 truncate text-sm font-semibold">{titleOf(row)}</h3>{dueOf(row) && <span className="shrink-0 text-[10px] font-semibold text-[var(--amber)]">Due</span>}</div><p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{row.location || "Location not added"}</p><p className="mt-3 text-xs">{[row.bhk && `${row.bhk} BHK`, row.area_sqft && `${row.area_sqft} sq ft`, row.quote].filter(Boolean).join(" · ") || "Details to be added"}</p><div className="mt-3 flex items-center justify-between gap-2"><select aria-label={`Move ${titleOf(row)}`} value={stageOf(row)} onChange={event => void move(row, event.target.value as Stage)} className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-xs"><option value="New">New</option><option value="Follow up">Follow up</option><option value="Viewing">Viewing</option><option value="Negotiation">Negotiation</option><option value="Closed">Closed</option></select><a href={shareUrl(row)} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--signal-dim)]">Share</a></div></article>)}</div></div>)}</div></section> : <section className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)]"><div className="overflow-x-auto"><table className="min-w-[760px] w-full text-left text-sm"><thead className="border-b border-[var(--border-subtle)] text-xs uppercase tracking-wide text-[var(--text-secondary)]"><tr><th className="px-4 py-3 font-semibold">Property</th><th className="px-4 py-3 font-semibold">Location</th><th className="px-4 py-3 font-semibold">Details</th><th className="px-4 py-3 font-semibold">Stage</th><th className="px-4 py-3 font-semibold">Action</th></tr></thead><tbody>{loading ? [1, 2, 3, 4].map(item => <tr key={item} className="border-b border-[var(--border-subtle)]"><td colSpan={5} className="px-4 py-4"><div className="h-5 animate-pulse rounded bg-[var(--border-subtle)]" /></td></tr>) : visibleRows.map(row => <tr key={row.id} className="border-b border-[var(--border-subtle)] last:border-0"><td className="px-4 py-3 font-semibold">{titleOf(row)}</td><td className="px-4 py-3 text-[var(--text-secondary)]">{row.location || "—"}</td><td className="px-4 py-3 text-[var(--text-secondary)]">{[row.bhk && `${row.bhk} BHK`, row.area_sqft && `${row.area_sqft} sq ft`, row.quote].filter(Boolean).join(" · ") || "—"}</td><td className="px-4 py-3"><select aria-label={`Stage for ${titleOf(row)}`} value={stageOf(row)} onChange={event => void move(row, event.target.value as Stage)} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 text-xs"><option>New</option><option>Follow up</option><option>Viewing</option><option>Negotiation</option><option>Closed</option></select></td><td className="px-4 py-3"><a href={shareUrl(row)} target="_blank" rel="noreferrer" className="font-semibold text-[var(--signal-dim)]">WhatsApp</a></td></tr>)}</tbody></table>{!loading && visibleRows.length === 0 && <p className="p-10 text-center text-sm text-[var(--text-secondary)]">No private records match this search.</p>}</div></section>}
    </div>
  </main>;
}
