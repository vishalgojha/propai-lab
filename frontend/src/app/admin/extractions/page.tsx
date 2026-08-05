"use client";

export const dynamic = "force-dynamic";

import { Fragment, useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, Table, Search, ChevronLeft, ChevronRight, X, Pencil, Save } from "lucide-react";
import { fetchJSON, updateParsedObservation } from "@/lib/api";

const PAGE_SIZE = 50;

interface ParsedRow {
  id: number;
  raw_message_id: number;
  intent: string | null;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  price_model: string | null;
  area_sqft: number | null;
  area_min_sqft?: number | null;
  area_max_sqft?: number | null;
  price_per_sqft?: number | null;
  budget_max?: number | null;
  furnishing: string | null;
  building_name: string | null;
  landmark_name: string | null;
  micro_market: string | null;
  location_raw: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  confidence: number | string | null;
  created_at: string;
  message_type: string | null;
  asset_type?: string | null;
  source_schema: string | null;
  summary_title?: string | null;
  floor_range?: string | null;
  parking_type?: string | null;
  car_parking_count?: number | null;
  commercial_use_type?: string | null;
}

interface RawMessage {
  id: number;
  sender?: string;
  sender_phone?: string;
  sender_jid?: string;
  group_name?: string;
  message?: string;
  message_type?: string;
  timestamp?: string;
  raw_payload?: unknown;
}

const LISTING_INTENTS = new Set(["SELL", "RENT", "LEASE", "COMMERCIAL", "PRE-LAUNCH"]);

function intentCategory(row: ParsedRow): "listing" | "requirement" {
  const i = (row.intent || "").toUpperCase();
  return LISTING_INTENTS.has(i) ? "listing" : "requirement";
}

function fmtPrice(value: number | null, unit: string | null): string {
  if (!value) return "-";
  const u = (unit || "").toUpperCase();
  if (u === "K") return `${(value / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 })}K`;
  if (value >= 10000000) return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (value >= 100000) return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  return value.toLocaleString("en-IN");
}

function fmtArea(row: ParsedRow): string {
  const min = row.area_min_sqft ?? row.area_sqft;
  const max = row.area_max_sqft;
  if (min == null && max == null) return "-";
  if (min != null && max != null && min !== max) {
    return `${min.toLocaleString("en-IN")}–${max.toLocaleString("en-IN")} sqft`;
  }
  return `${(min ?? max)!.toLocaleString("en-IN")} sqft`;
}

function fmtRowPrice(row: ParsedRow): string {
  if (row.message_type === "requirement" && row.budget_max != null) {
    return fmtPrice(row.budget_max, "abs");
  }
  if (row.price_model === "psf" || row.price_unit === "per_sqft") {
    const value = row.price_per_sqft ?? row.price;
    return value == null ? "-" : `₹${value.toLocaleString("en-IN")}/sqft`;
  }
  return fmtPrice(row.price, row.price_unit);
}

function detailRows(row: ParsedRow): Array<[string, string]> {
  const rows: Array<[string, string]> = [["Intent", row.intent || "—"]];
  if (row.asset_type !== "commercial") rows.push(["BHK", row.bhk || "—"]);
  rows.push(["Price", fmtRowPrice(row)], ["Price Model", row.price_model || "—"], ["Area", fmtArea(row)]);
  if (row.price_per_sqft != null && row.price_model !== "psf") {
    rows.push(["Price / sqft", `₹${row.price_per_sqft.toLocaleString("en-IN")}/sqft`]);
  }
  rows.push(
    ["Furnishing", row.furnishing || "—"], ["Building", row.building_name || "—"],
    ["Landmark", row.landmark_name || "—"], ["Micro Market", row.micro_market || "—"],
    ["Location Raw", row.location_raw || "—"], ["Broker", row.broker_name || "—"],
    ["Broker Phone", row.broker_phone || "—"], ["Message Type", row.message_type || "—"],
    ["Confidence", fmtConfidence(row.confidence).label], ["Created", fmtDate(row.created_at)],
  );
  return rows;
}

function fmtDate(value: string): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });
}

function fmtConfidence(c: number | string | null): { label: string; cls: string } {
  if (typeof c === "string") {
    const label = c.trim().toLowerCase();
    if (label === "high") return { label: "High", cls: "text-emerald-400" };
    if (label === "medium") return { label: "Medium", cls: "text-amber-400" };
    if (label === "low") return { label: "Low", cls: "text-red-400" };
    return { label: "Unknown", cls: "text-zinc-500" };
  }
  if (c == null || !Number.isFinite(c)) return { label: "Unknown", cls: "text-zinc-500" };
  if (c >= 0.8) return { label: `${Math.round(c * 100)}%`, cls: "text-emerald-400" };
  if (c >= 0.5) return { label: `${Math.round(c * 100)}%`, cls: "text-amber-400" };
  return { label: `${Math.round(c * 100)}%`, cls: "text-red-400" };
}

function schemaLabel(schema: string | null): string {
  return (schema || "unknown").replace(/_(listings|requirements)$/, "").replace(/_/g, " ");
}

export default function AdminExtractionsPage() {
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [intentFilter, setIntentFilter] = useState<"all" | "listing" | "requirement">("all");
  const [assetFilter, setAssetFilter] = useState<"all" | "residential" | "commercial">("all");
  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<ParsedRow | null>(null);
  const [rawMessage, setRawMessage] = useState<RawMessage | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editingRowId, setEditingRowId] = useState<number | null>(null);
  const [rowEditForm, setRowEditForm] = useState<Record<string, string>>({});
  const [rowSaving, setRowSaving] = useState(false);
  const [rowEditError, setRowEditError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"created" | "price" | "area" | "building">("created");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const formFromRow = (row: ParsedRow): Record<string, string> => ({
    summary_title: row.summary_title || "",
    building_name: row.building_name || "",
    micro_market: row.micro_market || "",
    location_raw: row.location_raw || "",
    bhk: row.bhk || "",
    area_sqft: row.area_sqft == null ? "" : String(row.area_sqft),
    price: row.price == null ? "" : String(row.price),
    furnishing: row.furnishing || "",
    floor_range: row.floor_range || "",
    parking_type: row.parking_type || "",
    car_parking_count: row.car_parking_count == null ? "" : String(row.car_parking_count),
    commercial_use_type: row.commercial_use_type || "",
  });

  const formUpdates = (form: Record<string, string>): Record<string, unknown> => {
    const updates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(form)) {
      if (["area_sqft", "price", "car_parking_count"].includes(key)) {
        if (value.trim() !== "") updates[key] = Number(value);
      } else if (value.trim() !== "") {
        updates[key] = value.trim();
      }
    }
    return updates;
  };

  useEffect(() => {
    let active = true;
    setLoading(true);

    const intentParam =
      intentFilter === "listing" ? "SELL" :
      intentFilter === "requirement" ? "BUY" : "";

    const classifiedParam = intentFilter === "all" ? "&classified_only=true" : "";
    const assetParam = assetFilter === "all" ? "" : `&asset_type=${assetFilter}`;
    fetchJSON<ParsedRow[]>(`/parsed?limit=${PAGE_SIZE}&offset=${offset}&intent=${intentParam}${classifiedParam}${assetParam}`)
      .then((data) => {
        if (active) {
          setRows(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (active) {
          setRows([]);
          setLoading(false);
        }
      });

    return () => { active = false; };
  }, [offset, intentFilter, assetFilter]);

  const filteredRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => {
      const haystack = [
        r.building_name, r.landmark_name, r.micro_market, r.location_raw,
        r.broker_name, r.broker_phone, r.intent, r.bhk,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, search]);

  const displayRows = useMemo(() => {
    const sorted = [...filteredRows].sort((a, b) => {
      let left: string | number = "";
      let right: string | number = "";
      if (sortBy === "price") { left = a.price ?? -1; right = b.price ?? -1; }
      else if (sortBy === "area") { left = a.area_sqft ?? -1; right = b.area_sqft ?? -1; }
      else if (sortBy === "building") { left = (a.building_name || "").toLowerCase(); right = (b.building_name || "").toLowerCase(); }
      else { left = a.created_at || ""; right = b.created_at || ""; }
      if (left < right) return sortDirection === "asc" ? -1 : 1;
      if (left > right) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredRows, sortBy, sortDirection]);

  useEffect(() => {
    if (!selectedRow?.raw_message_id) {
      setRawMessage(null);
      return;
    }
    let active = true;
    setRawLoading(true);
    setRawMessage(null);
    fetchJSON<RawMessage | RawMessage[]>(`/raw?raw_id=${selectedRow.raw_message_id}`)
      .then((data) => {
        if (active) setRawMessage(Array.isArray(data) ? data[0] || null : data);
      })
      .catch(() => { if (active) setRawMessage(null); })
      .finally(() => { if (active) setRawLoading(false); });
    return () => { active = false; };
  }, [selectedRow]);

  const beginEditing = () => {
    if (!selectedRow) return;
    setEditError(null);
    setEditForm(formFromRow(selectedRow));
    setEditing(true);
  };

  const saveEditing = async () => {
    if (!selectedRow) return;
    setSaving(true);
    setEditError(null);
    const updates = formUpdates(editForm);
    try {
      await updateParsedObservation(selectedRow.id, selectedRow.source_schema, updates);
      const next = { ...selectedRow, ...updates } as ParsedRow;
      setRows((current) => current.map((row) => row.id === next.id ? next : row));
      setSelectedRow(next);
      setEditing(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Could not save correction");
    } finally {
      setSaving(false);
    }
  };

  const beginRowEditing = (row: ParsedRow) => {
    setEditingRowId(row.id);
    setRowEditForm(formFromRow(row));
    setRowEditError(null);
  };

  const saveRowEditing = async (row: ParsedRow) => {
    setRowSaving(true);
    setRowEditError(null);
    const updates = formUpdates(rowEditForm);
    try {
      await updateParsedObservation(row.id, row.source_schema, updates);
      const next = { ...row, ...updates } as ParsedRow;
      setRows((current) => current.map((item) => item.id === next.id ? next : item));
      if (selectedRow?.id === next.id) setSelectedRow(next);
      setEditingRowId(null);
    } catch (error) {
      setRowEditError(error instanceof Error ? error.message : "Could not save correction");
    } finally {
      setRowSaving(false);
    }
  };

  const handleFilterChange = (f: "all" | "listing" | "requirement") => {
    setIntentFilter(f);
    setOffset(0);
    setSearch("");
  };

  const handleAssetChange = (f: "all" | "residential" | "commercial") => {
    setAssetFilter(f);
    setOffset(0);
    setSearch("");
  };

  const showBhk = assetFilter !== "commercial";

  return (
    <div className="theme-extractions w-full max-w-none px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/admin" className="text-zinc-400 hover:text-white">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">
            Super Admin
          </div>
          <h1 className="mt-1 text-2xl font-bold text-white flex items-center gap-2">
            <Table className="w-6 h-6 text-emerald-400" />
            Listings &amp; Requirements
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Combined view of all parsed extraction records. Filter by intent, search by location.
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="rounded-2xl border border-white/10 p-4 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {(["all", "listing", "requirement"] as const).map((f) => (
            <button
              key={f}
              onClick={() => handleFilterChange(f)}
              className={`px-4 py-2 text-xs font-semibold transition-colors ${
                intentFilter === f
                  ? "bg-emerald-400 text-black"
                  : "bg-zinc-800 text-zinc-400 hover:text-white"
              }`}
            >
              {f === "all" ? "All intents" : f === "listing" ? "Listings" : "Requirements"}
            </button>
          ))}
        </div>

        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {(["all", "residential", "commercial"] as const).map((f) => (
            <button
              key={f}
              onClick={() => handleAssetChange(f)}
              className={`px-4 py-2 text-xs font-semibold transition-colors ${
                assetFilter === f
                  ? "bg-sky-400 text-black"
                  : "bg-zinc-800 text-zinc-400 hover:text-white"
              }`}
            >
              {f === "all" ? "All property types" : f[0].toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search building, location, broker..."
            className="w-full pl-9 pr-8 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:border-emerald-400 focus:outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="text-xs text-zinc-500 ml-auto">
          {displayRows.length} records
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          Sort
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)} className="rounded-lg border border-white/10 bg-zinc-800 px-2 py-2 text-xs text-zinc-300 outline-none">
            <option value="created">Newest</option>
            <option value="price">Price</option>
            <option value="area">Area</option>
            <option value="building">Building</option>
          </select>
          <button onClick={() => setSortDirection((value) => value === "asc" ? "desc" : "asc")} className="rounded-lg border border-white/10 bg-zinc-800 px-2 py-2 text-xs text-zinc-300 hover:text-white" aria-label="Toggle sort direction">
            {sortDirection === "asc" ? "↑" : "↓"}
          </button>
        </label>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-white/10 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-sm text-zinc-500">Loading extractions...</div>
        ) : displayRows.length === 0 ? (
          <div className="p-12 text-center text-sm text-zinc-500">No records found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-3 w-16">ID</th>
                  <th className="px-4 py-3">Broker / Sender</th>
                  <th className="px-4 py-3">Schema</th>
                  <th className="px-4 py-3">Intent</th>
                  {showBhk && <th className="px-4 py-3">BHK</th>}
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Furnishing</th>
                  <th className="px-4 py-3">Building</th>
                  <th className="px-4 py-3">Raw Location</th>
                  <th className="px-4 py-3">Micro Market</th>
                  <th className="px-4 py-3">Conf.</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row) => {
                  const cat = intentCategory(row);
                  const conf = fmtConfidence(row.confidence);
                  return (
                    <Fragment key={row.id}>
                      <tr
                        onClick={() => setSelectedRow(row)}
                        className="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer transition-colors"
                      >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-500">{row.id}</td>
                      <td className="px-4 py-3">
                        <div className="text-zinc-300 truncate max-w-[180px]">
                          {row.broker_name || row.broker_phone || "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-zinc-400 whitespace-nowrap">
                        {schemaLabel(row.source_schema)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            cat === "listing"
                              ? "intent-listing border border-emerald-400/20 bg-emerald-400/10 text-emerald-400"
                              : "intent-requirement border border-blue-400/20 bg-blue-400/10 text-blue-400"
                          }`}
                        >
                          {row.intent || "—"}
                        </span>
                      </td>
                      {showBhk && <td className="px-4 py-3 text-zinc-400">{row.bhk || "—"}</td>}
                      <td className="px-4 py-3 text-zinc-300 font-medium whitespace-nowrap">
                        {fmtRowPrice(row)}
                      </td>
                      <td className="px-4 py-3 text-zinc-400">
                        {fmtArea(row)}
                      </td>
                      <td className="px-4 py-3 text-zinc-400 text-xs">
                        {row.furnishing || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-zinc-300 truncate max-w-[200px]">
                          {row.building_name || "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-zinc-400 text-xs truncate max-w-[180px]">
                        {row.location_raw || row.landmark_name || "—"}
                      </td>
                      <td className="px-4 py-3 text-zinc-400 text-xs truncate max-w-[140px]">
                        {row.micro_market || "—"}
                      </td>
                      <td className={`px-4 py-3 font-mono text-xs ${conf.cls}`}>
                        {conf.label}
                      </td>
                      <td className="px-4 py-3 text-zinc-500 text-xs whitespace-nowrap">
                        {fmtDate(row.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={(event) => { event.stopPropagation(); beginRowEditing(row); }}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 px-2 py-1 text-xs text-zinc-400 hover:border-emerald-400/50 hover:text-emerald-300"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      </td>
                      </tr>
                      {editingRowId === row.id && (
                        <tr className="border-b border-emerald-400/20 bg-emerald-400/[0.04]">
                          <td colSpan={showBhk ? 14 : 13} className="px-4 py-4">
                            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                              {[
                                ["summary_title", "Title"], ["building_name", "Building"], ["micro_market", "Micro market"],
                                ["location_raw", "Location"], ["bhk", "BHK / configuration"], ["area_sqft", "Area sqft"],
                                ["price", "Price"], ["furnishing", "Furnishing"], ["floor_range", "Floor"],
                                ["parking_type", "Parking"], ["car_parking_count", "Parking count"], ["commercial_use_type", "Commercial use"],
                              ].filter(([key]) => key !== "bhk" || row.asset_type !== "commercial").map(([key, label]) => (
                                <label key={key} className="text-xs text-zinc-500">
                                  {label}
                                  <input
                                    value={rowEditForm[key] || ""}
                                    onChange={(event) => setRowEditForm((current) => ({ ...current, [key]: event.target.value }))}
                                    className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white outline-none focus:border-emerald-400"
                                  />
                                </label>
                              ))}
                            </div>
                            {rowEditError && <p className="mt-2 text-xs text-red-400">{rowEditError}</p>}
                            <div className="mt-3 flex justify-end gap-2">
                              <button onClick={() => setEditingRowId(null)} disabled={rowSaving} className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-white">Cancel</button>
                              <button onClick={() => void saveRowEditing(row)} disabled={rowSaving} className="inline-flex items-center gap-1 rounded-md bg-emerald-400 px-3 py-1.5 text-xs font-semibold text-black hover:bg-emerald-300 disabled:opacity-50"><Save className="h-3 w-3" /> {rowSaving ? "Saving..." : "Save"}</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-400 hover:text-white disabled:opacity-40"
        >
          <ChevronLeft className="w-3 h-3" /> Prev
        </button>
        <span className="text-xs text-zinc-500">
          {filteredRows.length > 0 ? `${offset + 1}–${offset + filteredRows.length}` : "0"}
        </span>
        <button
          disabled={rows.length < PAGE_SIZE}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          className="flex items-center gap-1 rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-400 hover:text-white disabled:opacity-40"
        >
          Next <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      {/* Detail Modal */}
      {selectedRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setSelectedRow(null)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-900 p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">Extraction #{selectedRow.id}</h2>
                {!editing && <button onClick={beginEditing} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-300 hover:text-white"><Pencil className="h-3.5 w-3.5" /> Edit</button>}
              </div>
              <button onClick={() => { setEditing(false); setSelectedRow(null); }} className="text-zinc-500 hover:text-white" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>

            {editing ? (
              <div className="space-y-3">
                <p className="text-xs leading-5 text-zinc-400">Correct the structured extraction. The original WhatsApp message remains unchanged.</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    ["summary_title", "Title"], ["building_name", "Building"], ["micro_market", "Micro market"],
                    ["location_raw", "Location"], ["bhk", "BHK / configuration"], ["area_sqft", "Area sqft"],
                    ["price", "Price"], ["furnishing", "Furnishing"], ["floor_range", "Floor"],
                    ["parking_type", "Parking"], ["car_parking_count", "Parking count"], ["commercial_use_type", "Commercial use"],
                  ].filter(([key]) => key !== "bhk" || selectedRow.asset_type !== "commercial").map(([key, label]) => (
                    <label key={key} className="text-xs text-zinc-500">
                      {label}
                      <input
                        value={editForm[key] || ""}
                        onChange={(event) => setEditForm((current) => ({ ...current, [key]: event.target.value }))}
                        className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400"
                      />
                    </label>
                  ))}
                </div>
                {editError && <p className="text-xs text-red-400">{editError}</p>}
                <div className="flex justify-end gap-2 border-t border-white/10 pt-3">
                  <button onClick={() => setEditing(false)} disabled={saving} className="rounded-lg px-3 py-2 text-xs text-zinc-400 hover:text-white">Cancel</button>
                  <button onClick={() => void saveEditing()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-semibold text-black hover:bg-emerald-300 disabled:opacity-50"><Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : "Save correction"}</button>
                </div>
              </div>
            ) : <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ["Intent", selectedRow.intent || "—"],
                ...(selectedRow.asset_type === "commercial" ? [] : [["BHK", selectedRow.bhk || "—"]]),
                ["Price", fmtRowPrice(selectedRow)],
                ["Price Model", selectedRow.price_model || "—"],
                ["Area", fmtArea(selectedRow)],
                ["Furnishing", selectedRow.furnishing || "—"],
                ["Building", selectedRow.building_name || "—"],
                ["Landmark", selectedRow.landmark_name || "—"],
                ["Micro Market", selectedRow.micro_market || "—"],
                ["Location Raw", selectedRow.location_raw || "—"],
                ["Broker", selectedRow.broker_name || "—"],
                ["Broker Phone", selectedRow.broker_phone || "—"],
                ["Message Type", selectedRow.message_type || "—"],
                ["Confidence", fmtConfidence(selectedRow.confidence).label],
                ["Created", fmtDate(selectedRow.created_at)],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</div>
                  <div className="mt-0.5 text-zinc-300">{value}</div>
                </div>
              ))}
            </div>}

            {!editing && selectedRow.raw_message_id ? (
              <div className="border-t border-white/10 pt-4">
                <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                  Raw WhatsApp Message #{selectedRow.raw_message_id}
                </div>
                {rawLoading ? (
                  <div className="mt-2 text-sm text-zinc-500">Loading raw message...</div>
                ) : rawMessage ? (
                  <div className="mt-2 space-y-2">
                    <div className="text-xs text-zinc-500">
                      {rawMessage.sender || "Unknown sender"}
                      {rawMessage.sender_phone ? " - " + rawMessage.sender_phone.split("@")[0] : ""}
                      {rawMessage.group_name ? " - " + rawMessage.group_name : ""}
                    </div>
                    <div className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-zinc-200">
                      {rawMessage.message || "(No text content; see message metadata above.)"}
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-zinc-500">Raw message unavailable.</div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
