"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, Table, Search, ChevronLeft, ChevronRight, X } from "lucide-react";
import { fetchJSON } from "@/lib/api";

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
  furnishing: string | null;
  building_name: string | null;
  landmark_name: string | null;
  micro_market: string | null;
  location_raw: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  confidence: number | null;
  created_at: string;
  message_type: string | null;
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

function fmtDate(value: string): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });
}

function fmtConfidence(c: number | null): { label: string; cls: string } {
  if (c == null) return { label: "-", cls: "text-zinc-500" };
  if (c >= 0.8) return { label: `${Math.round(c * 100)}%`, cls: "text-emerald-400" };
  if (c >= 0.5) return { label: `${Math.round(c * 100)}%`, cls: "text-amber-400" };
  return { label: `${Math.round(c * 100)}%`, cls: "text-red-400" };
}

function locationDisplay(row: ParsedRow): string {
  return row.building_name || row.landmark_name || row.location_raw || "-";
}

export default function AdminExtractionsPage() {
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [intentFilter, setIntentFilter] = useState<"all" | "listing" | "requirement">("all");
  const [search, setSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<ParsedRow | null>(null);
  const [rawMessage, setRawMessage] = useState<RawMessage | null>(null);
  const [rawLoading, setRawLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);

    const intentParam =
      intentFilter === "listing" ? "SELL" :
      intentFilter === "requirement" ? "BUY" : "";

    const classifiedParam = intentFilter === "all" ? "&classified_only=true" : "";
    fetchJSON<ParsedRow[]>(`/parsed?limit=${PAGE_SIZE}&offset=${offset}&intent=${intentParam}${classifiedParam}`)
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
  }, [offset, intentFilter]);

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

  const handleFilterChange = (f: "all" | "listing" | "requirement") => {
    setIntentFilter(f);
    setOffset(0);
    setSearch("");
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
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
              {f === "all" ? "All" : f === "listing" ? "Listings" : "Requirements"}
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
          {filteredRows.length} records
        </div>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-white/10 overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-sm text-zinc-500">Loading extractions...</div>
        ) : filteredRows.length === 0 ? (
          <div className="p-12 text-center text-sm text-zinc-500">No records found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-3 w-16">ID</th>
                  <th className="px-4 py-3">Broker / Sender</th>
                  <th className="px-4 py-3">Intent</th>
                  <th className="px-4 py-3">BHK</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Area</th>
                  <th className="px-4 py-3">Furnishing</th>
                  <th className="px-4 py-3">Building / Location</th>
                  <th className="px-4 py-3">Micro Market</th>
                  <th className="px-4 py-3">Conf.</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const cat = intentCategory(row);
                  const conf = fmtConfidence(row.confidence);
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedRow(row)}
                      className="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer transition-colors"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-zinc-500">{row.id}</td>
                      <td className="px-4 py-3">
                        <div className="text-zinc-300 truncate max-w-[180px]">
                          {row.broker_name || row.broker_phone || "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                            cat === "listing"
                              ? "border border-emerald-400/20 bg-emerald-400/10 text-emerald-400"
                              : "border border-blue-400/20 bg-blue-400/10 text-blue-400"
                          }`}
                        >
                          {row.intent || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-400">{row.bhk || "—"}</td>
                      <td className="px-4 py-3 text-zinc-300 font-medium whitespace-nowrap">
                        {fmtPrice(row.price, row.price_unit)}
                        {row.price_model === "psf" && (
                          <span className="ml-1 text-[10px] text-zinc-500">/sqft</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-zinc-400">
                        {row.area_sqft ? `${row.area_sqft.toLocaleString("en-IN")}` : "—"}
                      </td>
                      <td className="px-4 py-3 text-zinc-400 text-xs">
                        {row.furnishing || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-zinc-300 truncate max-w-[200px]">
                          {locationDisplay(row)}
                        </div>
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
                    </tr>
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
              <h2 className="text-lg font-bold text-white">
                Extraction #{selectedRow.id}
              </h2>
              <button
                onClick={() => setSelectedRow(null)}
                className="text-zinc-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              {[
                ["Intent", selectedRow.intent || "—"],
                ["BHK", selectedRow.bhk || "—"],
                ["Price", fmtPrice(selectedRow.price, selectedRow.price_unit)],
                ["Price Model", selectedRow.price_model || "—"],
                ["Area", selectedRow.area_sqft ? `${selectedRow.area_sqft.toLocaleString("en-IN")} sqft` : "—"],
                ["Furnishing", selectedRow.furnishing || "—"],
                ["Building", selectedRow.building_name || "—"],
                ["Landmark", selectedRow.landmark_name || "—"],
                ["Micro Market", selectedRow.micro_market || "—"],
                ["Location Raw", selectedRow.location_raw || "—"],
                ["Broker", selectedRow.broker_name || "—"],
                ["Broker Phone", selectedRow.broker_phone || "—"],
                ["Message Type", selectedRow.message_type || "—"],
                ["Confidence", selectedRow.confidence != null ? `${Math.round(selectedRow.confidence * 100)}%` : "—"],
                ["Created", fmtDate(selectedRow.created_at)],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{label}</div>
                  <div className="mt-0.5 text-zinc-300">{value}</div>
                </div>
              ))}
            </div>

            {selectedRow.raw_message_id ? (
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
                      {rawMessage.sender_phone ? ` · ${rawMessage.sender_phone.replace(/@.*$/, "")}` : ""}
                      {rawMessage.group_name ? ` · ${rawMessage.group_name}` : ""}
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
