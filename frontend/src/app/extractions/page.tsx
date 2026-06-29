"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";

const PAGE_SIZE = 25;

function formatPrice(value?: number | null, unit?: string | null) {
  if (!value) return "-";
  if (unit === "K" || (value >= 1000 && value < 100000)) {
    return `${(value / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} K`;
  }
  if (value >= 10000000) return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (value >= 100000) return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
  return value.toLocaleString("en-IN");
}

function formatDate(value: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function confidenceLabel(row: api.ListingRow) {
  const missing = [
    !row.location_label && !row.micro_market ? "location" : "",
    !row.price ? "price" : "",
    !row.broker_name && !row.broker_phone ? "source" : "",
  ].filter(Boolean);

  if (missing.length >= 2) return "low";
  if (missing.length === 1) return "needs check";
  return "usable";
}

function confidenceClass(label: string) {
  if (label === "usable") return "border-[#3EE88A]/20 bg-[#3EE88A]/10 text-[#3EE88A]";
  if (label === "needs check") return "border-[#f59e0b]/20 bg-[#f59e0b]/10 text-[#fbbf24]";
  return "border-[#ef4444]/20 bg-[#ef4444]/10 text-[#f87171]";
}

export default function ExtractionsPage() {
  const [rows, setRows] = useState<api.ListingRow[] | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    let active = true;
    api.getListings(PAGE_SIZE, offset)
      .then((nextRows) => {
        if (active) setRows(nextRows);
      })
      .catch(() => {
        if (active) setRows([]);
      });
    return () => {
      active = false;
    };
  }, [offset]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#64748b]">Parser Output</div>
          <h1 className="mt-2 text-2xl font-bold text-[#e2e8f0]">Extraction Review</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#94a3b8]">
            Low-trust candidates produced by the old parser. Use this only to inspect extraction quality; WhatsApp Audit and Knowledge Base are the source of truth.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/knowledge" className="rounded-lg bg-[#3EE88A] px-3 py-2 text-xs font-semibold text-[#04100a]">
            Open Knowledge Base
          </Link>
          <Link href="/audit" className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-xs font-semibold text-[#94a3b8] hover:text-white">
            Open WhatsApp Audit
          </Link>
        </div>
      </div>

      <div className="rounded-lg border border-[#f59e0b]/20 bg-[#f59e0b]/10 p-4">
        <div className="text-sm font-semibold text-[#fbbf24]">Do not treat these rows as verified inventory.</div>
        <div className="mt-1 text-xs leading-5 text-[#94a3b8]">
          Parser extraction is kept as an internal review queue while the product moves to knowledge-based retrieval.
          Promote, WhatsApp outreach, and market-action workflows have been removed from this page.
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-[rgba(255,255,255,0.06)] bg-[#0d1117]">
        <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.06)] px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-[#e2e8f0]">Recent Parser Candidates</h2>
            <div className="mt-1 text-xs text-[#64748b]">Shown for QA and migration checks only.</div>
          </div>
          <button
            onClick={() => {
              setRows(null);
              api.getListings(PAGE_SIZE, offset).then(setRows).catch(() => setRows([]));
            }}
            className="rounded-lg border border-[rgba(255,255,255,0.1)] px-3 py-1.5 text-xs font-semibold text-[#94a3b8] hover:text-white"
          >
            Refresh
          </button>
        </div>

        {rows === null ? (
          <div className="p-8 text-center text-sm text-[#64748b]">Loading parser candidates...</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#64748b]">No parser candidates found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[rgba(255,255,255,0.06)] text-left text-[11px] uppercase tracking-wider text-[#64748b]">
                  <th className="px-4 py-3">Candidate</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Parser Read</th>
                  <th className="px-4 py-3">Evidence</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = confidenceLabel(row);
                  const searchTerm = row.building_name || row.location_label || row.micro_market || row.broker_name || "";
                  return (
                    <tr key={row.id} className="border-b border-[rgba(255,255,255,0.04)] last:border-b-0">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-[#e2e8f0]">
                          {[row.bhk, row.building_name || row.location_label || row.micro_market].filter(Boolean).join(" · ") || `Candidate #${row.id}`}
                        </div>
                        <div className="mt-1 text-xs text-[#64748b]">{formatDate(row.latest_timestamp || row.last_seen)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="max-w-[220px] truncate text-[#94a3b8]">{row.broker_name || row.broker_phone || "Unknown source"}</div>
                        <div className="mt-1 max-w-[220px] truncate text-xs text-[#64748b]">{row.latest_group || "WhatsApp"}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[#94a3b8]">{row.intent || "-"} · {formatPrice(row.price, row.price_unit)}</div>
                        <div className="mt-1 text-xs text-[#64748b]">{row.area_sqft ? `${row.area_sqft.toLocaleString("en-IN")} sqft` : "area unknown"}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-[#94a3b8]">{row.observation_count} posts · {row.group_count} groups</div>
                        {searchTerm ? (
                          <Link href={`/search?q=${encodeURIComponent(searchTerm)}`} className="mt-1 inline-flex text-xs font-semibold text-[#58a6ff] hover:text-[#8abfff]">
                            Check raw knowledge
                          </Link>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${confidenceClass(status)}`}>
                          {status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          disabled={offset === 0}
          onClick={() => {
            setRows(null);
            setOffset(Math.max(0, offset - PAGE_SIZE));
          }}
          className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-1.5 text-xs text-[#94a3b8] disabled:opacity-40"
        >
          Prev
        </button>
        <span className="text-xs text-[#64748b]">{rows?.length ? `${offset + 1}-${offset + rows.length}` : "0"}</span>
        <button
          disabled={(rows?.length || 0) < PAGE_SIZE}
          onClick={() => {
            setRows(null);
            setOffset(offset + PAGE_SIZE);
          }}
          className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-1.5 text-xs text-[#94a3b8] disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
