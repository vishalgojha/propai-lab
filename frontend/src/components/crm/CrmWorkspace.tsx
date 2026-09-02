"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createCrmInventory,
  createCrmInventoryField,
  getCrmInventory,
  getCrmInventoryFields,
  importCrmInventory,
  updateCrmInventory,
  type CrmInventoryField,
  type CrmInventoryItem,
} from "@/lib/api";
import { Badge } from "@/components/ui/badge";

const stages = ["New", "Follow up", "Viewing", "Negotiation", "Closed"] as const;
type Stage = typeof stages[number];
type Draft = Record<string, string | number | boolean>;

const baseFields: Array<[keyof CrmInventoryItem, string]> = [
  ["building_name", "Property name"], ["location", "Location"], ["transaction_type", "Transaction"],
  ["asset_type", "Asset type"], ["bhk", "BHK"], ["area_sqft", "Area (sq ft)"], ["quote", "Quote"],
  ["furnishing", "Furnishing"], ["availability", "Availability"], ["contact_name", "Contact name"],
  ["contact_number", "Contact number"], ["notes", "Notes"],
];

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
  const summary = [titleOf(row), row.location, row.bhk && `${row.bhk} BHK`, row.area_sqft && `${row.area_sqft} sq ft`, row.quote].filter(Boolean).join(" · ");
  return `https://wa.me/?text=${encodeURIComponent(`Hi, sharing this property with you:\n${summary}`)}`;
}

function inputType(field: CrmInventoryField) {
  if (field.field_type === "date") return "date";
  if (field.field_type === "number" || field.field_type === "currency") return "number";
  if (field.field_type === "checkbox") return "checkbox";
  return "text";
}

export default function CrmWorkspace() {
  const [rows, setRows] = useState<CrmInventoryItem[]>([]);
  const [fields, setFields] = useState<CrmInventoryField[]>([]);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"pipeline" | "records">("pipeline");
  const [stageFilter, setStageFilter] = useState<Stage | "all">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<CrmInventoryItem | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [newField, setNewField] = useState("");
  const [newFieldType, setNewFieldType] = useState<CrmInventoryField["field_type"]>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try {
      const [inventory, customFields] = await Promise.all([getCrmInventory(query), getCrmInventoryFields()]);
      setRows(inventory);
      setFields(customFields);
      setError("");
    } catch {
      setError("Private inventory could not be loaded. Try refreshing the workspace.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [query]);

  const visibleRows = useMemo(() => rows.filter(row => stageFilter === "all" || stageOf(row) === stageFilter), [rows, stageFilter]);
  const dueCount = useMemo(() => rows.filter(dueOf).length, [rows]);
  const activeCount = useMemo(() => rows.filter(row => !["New", "Closed"].includes(stageOf(row))).length, [rows]);
  const grouped = useMemo(() => stages.map(stage => ({ stage, rows: visibleRows.filter(row => stageOf(row) === stage) })), [visibleRows]);

  function openEditor(row: CrmInventoryItem) {
    const values: Draft = {};
    for (const [key] of baseFields) values[key] = row[key] == null ? "" : row[key] as string | number | boolean;
    for (const field of fields) values[field.field_key] = row.custom_fields?.[field.field_key] ?? "";
    values.workflow_stage = stageOf(row);
    values.follow_up_date = row.custom_fields?.follow_up_date ?? "";
    setEditing(row);
    setDraft(values);
    setMessage("");
    setError("");
  }

  function closeEditor() {
    setEditing(null);
    setDraft({});
  }

  function setValue(key: string, value: string | number | boolean) {
    setDraft(current => ({ ...current, [key]: value }));
  }

  async function saveRecord() {
    if (!editing) return;
    setBusy(true);
    try {
      const basePayload: Record<string, unknown> = {};
      for (const [key] of baseFields) basePayload[key] = draft[key] ?? "";
      const customFields = { ...(editing.custom_fields || {}) } as Record<string, string | number | boolean>;
      for (const field of fields) customFields[field.field_key] = draft[field.field_key] ?? "";
      customFields.workflow_stage = String(draft.workflow_stage || "New");
      customFields.follow_up_date = String(draft.follow_up_date || "");
      const saved = await updateCrmInventory(editing.id, { ...basePayload, custom_fields: customFields });
      setRows(current => current.map(row => row.id === saved.id ? saved : row));
      setEditing(saved);
      setMessage("Record saved.");
      setError("");
    } catch {
      setError("This record could not be saved. Check the fields and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function addRow() {
    setBusy(true);
    try {
      const row = await createCrmInventory({ building_name: "", location: "", custom_fields: { workflow_stage: "New" } });
      setRows(current => [row, ...current]);
      openEditor(row);
      setView("records");
      setMessage("New private record started. Add the property details and save it.");
    } catch {
      setError("The private record could not be created.");
    } finally {
      setBusy(false);
    }
  }

  async function addField(event: React.FormEvent) {
    event.preventDefault();
    if (!newField.trim()) return;
    setBusy(true);
    try {
      const field = await createCrmInventoryField({ label: newField, field_type: newFieldType, options: newFieldOptions.split(",").map(item => item.trim()).filter(Boolean) });
      setFields(current => [...current.filter(item => item.field_key !== field.field_key), field]);
      if (editing) setValue(field.field_key, "");
      setNewField("");
      setNewFieldOptions("");
      setMessage(`${field.label} is now available on every private record.`);
    } catch {
      setError("That custom field could not be added.");
    } finally {
      setBusy(false);
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
        <div><p className="text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--signal-dim)]">Private workspace</p><h1 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">CRM workspace</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-secondary)]">Manage private property records, track the next action, and share only the inventory you choose.</p></div>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void addRow()} disabled={busy} className="rounded-lg bg-[var(--signal-dim)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Add property</button><input ref={fileRef} type="file" accept=".csv,.tsv,.json,.xlsx,.xls" className="hidden" onChange={event => void importFile(event.target.files?.[0])} /><button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="rounded-lg border border-[var(--border-strong)] px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Import sheet</button><a href="/chat" className="rounded-lg border border-[var(--border-strong)] px-4 py-2.5 text-sm font-semibold">Add from chat</a></div>
      </header>

      <section className="mt-5 grid gap-3 sm:grid-cols-3">{[["Total records", rows.length], ["Needs follow-up", dueCount], ["Active pipeline", activeCount]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-4"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{label}</p>{loading ? <div className="mt-3 h-7 w-16 animate-pulse rounded bg-[var(--border-subtle)]" /> : <p className="mt-2 text-2xl font-semibold">{value}</p>}</div>)}</section>

      <section className="mt-5 flex flex-col gap-3 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] p-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex gap-1 rounded-lg bg-[var(--bg-base)] p-1"><button type="button" onClick={() => setView("pipeline")} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === "pipeline" ? "bg-[var(--signal-dim)] text-white" : "text-[var(--text-secondary)]"}`}>Pipeline</button><button type="button" onClick={() => setView("records")} className={`rounded-md px-3 py-1.5 text-xs font-semibold ${view === "records" ? "bg-[var(--signal-dim)] text-white" : "text-[var(--text-secondary)]"}`}>All records</button></div><label className="block w-full sm:max-w-sm"><span className="sr-only">Search private records</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search properties, locations, or contacts" className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]" /></label></section>

      {message && <p role="status" className="mt-4 rounded-lg border border-[var(--signal-dim)]/40 bg-[var(--signal-dim)]/10 px-4 py-3 text-sm">{message}</p>}{error && <p role="alert" className="mt-4 rounded-lg border border-[var(--amber)]/40 bg-[var(--amber)]/10 px-4 py-3 text-sm">{error}</p>}

      {editing && <section className="mt-5 rounded-xl border border-[var(--signal-dim)]/45 bg-[var(--surface-raised)] p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-subtle)] pb-4"><div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--signal-dim)]">Record details</p><h2 className="mt-1 text-lg font-semibold">{titleOf(editing)}</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">Private to your workspace. Changes are saved to this record only.</p></div><button type="button" onClick={closeEditor} className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold">Close editor</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{baseFields.map(([key, label]) => <label key={String(key)} className="block"><span className="mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]">{label}</span><input value={String(draft[key] ?? "")} onChange={event => setValue(String(key), event.target.value)} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]" /></label>)}<label className="block"><span className="mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]">Pipeline stage</span><select value={String(draft.workflow_stage || "New")} onChange={event => setValue("workflow_stage", event.target.value)} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]">{stages.map(stage => <option key={stage}>{stage}</option>)}</select></label><label className="block"><span className="mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]">Next follow-up</span><input type="date" value={String(draft.follow_up_date || "")} onChange={event => setValue("follow_up_date", event.target.value)} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]" /></label>{fields.map(field => <label key={field.field_key} className="block"><span className="mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]">{field.label}</span>{field.field_type === "select" ? <select value={String(draft[field.field_key] ?? "")} onChange={event => setValue(field.field_key, event.target.value)} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]"><option value="">Choose one</option>{(field.options || []).map(option => <option key={option}>{option}</option>)}</select> : <input type={inputType(field)} checked={field.field_type === "checkbox" ? Boolean(draft[field.field_key]) : undefined} value={field.field_type === "checkbox" ? undefined : String(draft[field.field_key] ?? "")} onChange={event => setValue(field.field_key, field.field_type === "checkbox" ? event.target.checked : event.target.value)} className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg-base)] px-3 py-2 text-sm outline-none focus:border-[var(--signal-dim)]" />}</label>)}</div><div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4"><form onSubmit={addField} className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold text-[var(--text-secondary)]">Add custom field</span><input value={newField} onChange={event => setNewField(event.target.value)} placeholder="e.g. Client" aria-label="Custom field name" className="w-32 rounded-md border border-[var(--border-strong)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs" /><select value={newFieldType} onChange={event => setNewFieldType(event.target.value as CrmInventoryField["field_type"])} aria-label="Custom field type" className="rounded-md border border-[var(--border-strong)] bg-[var(--bg-base)] px-2 py-1.5 text-xs"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="currency">Currency</option><option value="checkbox">Checkbox</option><option value="select">Select</option></select>{newFieldType === "select" && <input value={newFieldOptions} onChange={event => setNewFieldOptions(event.target.value)} placeholder="A, B" aria-label="Custom field options" className="w-24 rounded-md border border-[var(--border-strong)] bg-[var(--bg-base)] px-2.5 py-1.5 text-xs" />}<button type="submit" disabled={busy || !newField.trim()} className="rounded-md border border-[var(--border-strong)] px-3 py-1.5 text-xs font-semibold">Add field</button></form><button type="button" onClick={() => void saveRecord()} disabled={busy} className="rounded-lg bg-[var(--signal-dim)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : "Save record"}</button></div></section>}

      {view === "pipeline" ? <section className="mt-6"><div className="mb-4 flex flex-wrap gap-2">{["all", ...stages].map(stage => <button type="button" key={stage} onClick={() => setStageFilter(stage as Stage | "all")} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${stageFilter === stage ? "border-[var(--signal-dim)] bg-[var(--signal-dim)]/15 text-[var(--signal-dim)]" : "border-[var(--border-subtle)] text-[var(--text-secondary)]"}`}>{stage === "all" ? "All stages" : stage}</button>)}</div><div className="grid gap-4 overflow-x-auto pb-3 md:grid-cols-2 xl:grid-cols-5">{grouped.map(group => <div key={group.stage} className="min-w-[245px] rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)]"><div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-3"><h2 className="text-sm font-semibold">{group.stage}</h2><span className="text-xs text-[var(--text-secondary)]">{group.rows.length}</span></div><div className="space-y-2 p-2">{loading ? <><div className="h-28 animate-pulse rounded-lg bg-[var(--border-subtle)]" /><div className="h-24 animate-pulse rounded-lg bg-[var(--border-subtle)]" /></> : group.rows.length === 0 ? <p className="px-2 py-6 text-center text-xs text-[var(--text-secondary)]">No records here</p> : group.rows.slice(0, 20).map(row => <article key={row.id} className="rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3"><button type="button" onClick={() => openEditor(row)} className="block w-full text-left"><div className="flex items-start justify-between gap-2"><h3 className="min-w-0 truncate text-sm font-semibold">{titleOf(row)}</h3>{dueOf(row) && <span className="shrink-0 text-[10px] font-semibold text-[var(--amber)]">Due</span>}</div><p className="mt-1 truncate text-xs text-[var(--text-secondary)]">{row.location || "Location not added"}</p><p className="mt-3 text-xs">{[row.bhk && `${row.bhk} BHK`, row.area_sqft && `${row.area_sqft} sq ft`, row.quote].filter(Boolean).join(" · ") || "Details to be added"}</p></button><div className="mt-3 flex items-center justify-between gap-2"><select aria-label={`Move ${titleOf(row)}`} value={stageOf(row)} onChange={event => void updateCrmInventory(row.id, { custom_fields: { ...(row.custom_fields || {}), workflow_stage: event.target.value } }).then(saved => setRows(current => current.map(item => item.id === saved.id ? saved : item))).catch(() => setError("The stage could not be saved."))} className="min-w-0 flex-1 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-1.5 text-xs"><option>New</option><option>Follow up</option><option>Viewing</option><option>Negotiation</option><option>Closed</option></select><a href={shareUrl(row)} target="_blank" rel="noreferrer" className="text-xs font-semibold text-[var(--signal-dim)]">Share</a></div></article>)}</div></div>)}</div></section> : <section className="mt-6 overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)]"><div className="overflow-x-auto"><table className="min-w-[900px] w-full text-left text-sm"><thead className="border-b border-[var(--border-subtle)] text-xs uppercase tracking-wide text-[var(--text-secondary)]"><tr><th className="px-4 py-3 font-semibold">Property</th><th className="px-4 py-3 font-semibold">Location</th><th className="px-4 py-3 font-semibold">Details</th><th className="px-4 py-3 font-semibold">Custom fields</th><th className="px-4 py-3 font-semibold">Stage</th><th className="px-4 py-3 font-semibold">Action</th></tr></thead><tbody>{loading ? [1, 2, 3, 4].map(item => <tr key={item} className="border-b border-[var(--border-subtle)]"><td colSpan={6} className="px-4 py-4"><div className="h-5 animate-pulse rounded bg-[var(--border-subtle)]" /></td></tr>) : visibleRows.map(row => <tr key={row.id} className="border-b border-[var(--border-subtle)] last:border-0"><td className="px-4 py-3 font-semibold"><button type="button" onClick={() => openEditor(row)} className="text-left hover:text-[var(--signal-dim)]">{titleOf(row)}</button></td><td className="px-4 py-3 text-[var(--text-secondary)]">{row.location || "—"}</td><td className="px-4 py-3 text-[var(--text-secondary)]">{[row.bhk && `${row.bhk} BHK`, row.area_sqft && `${row.area_sqft} sq ft`, row.quote].filter(Boolean).join(" · ") || "—"}</td><td className="max-w-[260px] px-4 py-3 text-xs text-[var(--text-secondary)]">{fields.map(field => row.custom_fields?.[field.field_key] ? `${field.label}: ${row.custom_fields[field.field_key]}` : "").filter(Boolean).join(" · ") || "—"}</td><td className="px-4 py-3"><select aria-label={`Stage for ${titleOf(row)}`} value={stageOf(row)} onChange={event => void updateCrmInventory(row.id, { custom_fields: { ...(row.custom_fields || {}), workflow_stage: event.target.value } }).then(saved => setRows(current => current.map(item => item.id === saved.id ? saved : item))).catch(() => setError("The stage could not be saved."))} className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-base)] px-2 py-1.5 text-xs"><option>New</option><option>Follow up</option><option>Viewing</option><option>Negotiation</option><option>Closed</option></select></td><td className="px-4 py-3"><a href={shareUrl(row)} target="_blank" rel="noreferrer" className="font-semibold text-[var(--signal-dim)]">WhatsApp</a></td></tr>)}</tbody></table>{!loading && visibleRows.length === 0 && <p className="p-10 text-center text-sm text-[var(--text-secondary)]">No private records match this search.</p>}</div></section>}
    </div>
  </main>;
}
