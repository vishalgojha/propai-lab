"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";

const PAGE_SIZE = 100;

function formatPrice(value?: number | null) {
  if (!value) return "";
  if (value >= 10000000) {
    return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (value >= 100000) {
    return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
  }
  return value.toLocaleString("en-IN");
}

function isRequirement(row: api.ParsedObservation) {
  const intent = (row.intent || "").toUpperCase();
  const principal = (row.principal || "").toUpperCase();
  const text = `${row.raw_message || ""} ${row.location_raw || ""}`.toLowerCase();

  return (
    intent === "BUY" ||
    intent === "BUYER" ||
    intent === "REQUIREMENT" ||
    intent === "RENTAL_SEEKER" ||
    principal.includes("BUYER") ||
    text.includes("requirement") ||
    text.includes("client req") ||
    text.includes("wanted")
  );
}

function haystack(row: api.ParsedObservation) {
  return [
    row.broker_name,
    row.broker_phone,
    row.intent,
    row.principal,
    row.bhk,
    row.location_raw,
    row.landmark_name,
    row.micro_market,
    row.raw_message,
    row.raw_group,
  ].filter(Boolean).join(" ").toLowerCase();
}

function whatsappLink(row: api.ParsedObservation): string {
  const phone = (row.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (phone.length !== 10) return "";
  const need = [row.bhk, row.location_raw || row.micro_market, row.price ? formatPrice(row.price) : ""]
    .filter(Boolean)
    .join(" ");
  const text = `Hi, checking your requirement${need ? ` for ${need}` : ""}. Is it still active?`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

export default function RequirementsPage() {
  const [rows, setRows] = useState<api.ParsedObservation[]>([]);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");

  const load = useCallback(() => {
    api.getParsed(PAGE_SIZE, offset).then(setRows);
  }, [offset]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => isRequirement(row) && (!q || haystack(row).includes(q)));
  }, [rows, search]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-[#e2e8f0]">Market Buyers</h2>
        <div className="text-sm text-[#64748b] mt-1">Buyer needs currently circulating in broker groups.</div>
      </div>
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        <input
          type="text"
          placeholder="Search market buyers..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="px-2.5 py-1.5 bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm text-[#e2e8f0]"
        />
        <button onClick={load} className="px-3 py-1.5 bg-[#3EE88A] text-[#04100a] rounded-lg text-sm font-bold">Refresh</button>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table text-sm">
          <thead>
            <tr>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">ID</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Broker</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Need</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Budget</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Location</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Message</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const waLink = whatsappLink(row);
              const matchQuery = [row.bhk, row.location_raw, row.landmark_name, row.micro_market, formatPrice(row.price)]
                .filter(Boolean)
                .join(" ");

              return (
                <tr key={row.id} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <a href={`/observations/${row.raw_message_id}`} className="text-[#58a6ff] font-semibold no-underline hover:underline">P{row.id}</a>
                    <div className="text-[10px] text-[#64748b]">{row.raw_group}</div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">
                    <div className="broker-cell">
                      <span>{row.broker_name || "-"}</span>
                      {waLink && <a href={waLink} target="_blank" rel="noreferrer" className="wa-icon" title="Message on WhatsApp" aria-label="Message on WhatsApp">WA</a>}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <span className="badge badge-purple">{row.intent || "Buyer"}</span>
                    {row.bhk && <span className="ml-2">{row.bhk}</span>}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{formatPrice(row.price) || "-"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[240px] max-w-[420px] break-words">
                    {row.location_raw || row.landmark_name || row.micro_market || "-"}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[480px]">
                    <div className="message-preview">{row.raw_message}</div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[150px]">
                    <div className="flex flex-wrap gap-2">
                      <a href={`/observations/${row.raw_message_id}`} className="text-xs font-semibold text-[#58a6ff] hover:underline">View</a>
                      {matchQuery && <a href={`/search?q=${encodeURIComponent(matchQuery)}`} className="text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg px-2.5 py-1">Match</a>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2 items-center mt-3">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="px-3 py-1 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm disabled:opacity-40">Prev</button>
        <span className="text-sm text-[#64748b]">{filtered.length > 0 ? `${offset + 1}-${offset + filtered.length}` : "0"}</span>
        <button disabled={rows.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)} className="px-3 py-1 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}
