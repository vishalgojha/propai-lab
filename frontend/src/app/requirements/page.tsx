"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import SourceDrawer from "@/components/SourceDrawer";
import MatchDrawer from "@/components/MatchDrawer";

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
  if (intent === "BUY" || intent === "BUYER" || intent === "RENTAL_SEEKER") return true;
  if (principal.includes("BUYER")) return true;
  return false;
}

function haystack(row: api.ParsedObservation) {
  return [
    row.broker_name, row.broker_phone, row.intent, row.principal,
    row.bhk, row.location_raw, row.landmark_name, row.micro_market,
    row.building_name, row.developer, row.furnishing,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isValidPhone(phone: string): boolean {
  const digits = (phone || "").replace(/[^0-9]/g, "").slice(-10);
  return digits.length === 10;
}

function phoneDisplay(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (digits.length !== 10) return phone || "";
  return `+91 ${digits.slice(0, 2)} ${digits.slice(2, 7)} ${digits.slice(7)}`;
}

function formatRelativeTime(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return "yesterday";
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

function intentLabel(intent?: string | null) {
  if (!intent) return "Buyer";
  const map: Record<string, string> = {
    BUY: "Buy", BUYER: "Buyer", RENTAL_SEEKER: "Tenant",
  };
  return map[intent] || intent;
}

function intentClass(intent?: string | null) {
  const label = intentLabel(intent);
  if (label === "Buy") return "badge-purple";
  if (label === "Rent Seek") return "badge-yellow";
  return "badge-blue";
}

function whatsappLink(row: api.ParsedObservation): string {
  const phone = (row.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (phone.length !== 10) return "";

  const need = [row.bhk, row.location_raw || row.micro_market, row.price ? formatPrice(row.price) : ""]
    .filter(Boolean)
    .join(" \u2022 ");

  const sourceLine = "Found via PropAI";
  const timeLine = row.raw_timestamp
    ? `Posted: ${formatRelativeTime(row.raw_timestamp)}`
    : "";

  const lines = [
    `Hi,`, ``,
    `I came across your requirement through PropAI.`, ``,
    need && `Need: ${need}`,
    sourceLine, timeLine, ``,
    `Is this still active?`,
  ];

  return `https://wa.me/91${phone}?text=${encodeURIComponent(lines.filter(Boolean).join("\n"))}`;
}

export default function RequirementsPage() {
  const [rows, setRows] = useState<api.ParsedObservation[]>([]);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [sourceParsed, setSourceParsed] = useState<api.ParsedObservation | null>(null);
  const [matchSummary, setMatchSummary] = useState<Record<string, { count: number; best: number }>>({});
  const [matchDrawerId, setMatchDrawerId] = useState<number | null>(null);

  const load = useCallback(() => {
    api.getParsed(PAGE_SIZE, offset).then(setRows);
    api.getRequirementMatchesSummary().then(setMatchSummary);
  }, [offset]);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => isRequirement(row) && (!q || haystack(row).includes(q)));
  }, [rows, search]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-[#e2e8f0]">Extracted Requirements</h2>
        <div className="text-sm text-[#64748b] mt-1">
          Parser-generated buyer and tenant needs from captured WhatsApp knowledge. Use this as a work queue; open Sources to verify the original message.
        </div>
      </div>
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        <input
          type="text"
          placeholder="Search by broker, building, location, developer..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="px-2.5 py-1.5 bg-[#0d1117] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm text-[#e2e8f0] min-w-[300px]"
        />
        <button onClick={load} className="px-3 py-1.5 bg-[#3EE88A] text-[#04100a] rounded-lg text-sm font-bold">Refresh</button>
        <button
          onClick={async () => {
            await api.matchRequirements();
            load();
          }}
          className="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-sm font-bold"
        >
          Re-match
        </button>
        <span className="text-xs text-[#64748b]">{filtered.length} extracted requirements</span>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table text-sm">
          <thead>
            <tr>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Need</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Budget</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Markets</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Buildings</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Details</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Broker</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Seen</th>
              <th className="text-right px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Matches</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const waLink = whatsappLink(row);
              const matchQuery = [row.bhk, row.location_raw || row.micro_market, row.building_name, formatPrice(row.price)]
                .filter(Boolean).join(" ");
              const markets = [row.micro_market, row.location_raw].filter(Boolean);
              const details = [row.furnishing, row.developer, row.area_sqft ? `${row.area_sqft} sqft` : ""].filter(Boolean);

              return (
                <tr key={row.id} className="hover:bg-[#0d1117]">
                  {/* Need */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <div className="flex items-center gap-1.5">
                      <span className={`badge ${intentClass(row.intent)} text-[10px]`}>{intentLabel(row.intent)}</span>
                      {row.bhk && <span className="text-sm font-semibold text-[#e2e8f0]">{row.bhk}</span>}
                    </div>
                  </td>

                  {/* Budget */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <span className="text-sm font-semibold text-[#e2e8f0]">{formatPrice(row.price) || "—"}</span>
                    {row.intent === "RENTAL_SEEKER" && row.price && <span className="text-[10px] text-[#64748b]">/mo</span>}
                  </td>

                  {/* Markets */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[180px]">
                    {markets.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {markets.map((m) => (
                          <span key={m} className="text-[10px] bg-[#111820] border border-[rgba(255,255,255,0.08)] rounded px-1.5 py-0.5 text-[#94a3b8]">{m}</span>
                        ))}
                      </div>
                    ) : <span className="text-[#475569]">—</span>}
                  </td>

                  {/* Buildings */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[160px]">
                    {row.building_name ? (
                      <span className="text-xs text-[#e2e8f0] font-semibold">{row.building_name}</span>
                    ) : <span className="text-[#475569]">—</span>}
                  </td>

                  {/* Details (furnishing, developer, area) */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    {details.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {details.map((d) => (
                          <span key={d} className="text-[10px] text-[#64748b]">{d}</span>
                        ))}
                      </div>
                    ) : <span className="text-[#475569]">—</span>}
                  </td>

                  {/* Broker */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <div className="broker-cell">
                      <span className="text-xs font-semibold text-[#e2e8f0]">{row.broker_name || (row.broker_phone ? phoneDisplay(row.broker_phone) : "—")}</span>
                      {waLink && <a href={waLink} target="_blank" rel="noreferrer" className="wa-icon" title="Message on WhatsApp">WA</a>}
                    </div>
                    {row.broker_phone && isValidPhone(row.broker_phone) && (
                      <div className="text-[10px] text-[#64748b] font-mono mt-0.5">{phoneDisplay(row.broker_phone)}</div>
                    )}
                  </td>

                  {/* Seen */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <span className="text-[11px] text-[#64748b]">{formatRelativeTime(row.raw_timestamp || row.created_at)}</span>
                  </td>

                  {/* Matches */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-right">
                    {matchSummary[String(row.id)] ? (
                      <button
                        onClick={() => setMatchDrawerId(row.id)}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-colors ${
                          matchSummary[String(row.id)].count > 0
                            ? "bg-[#3EE88A]/20 text-[#3EE88A] hover:bg-[#3EE88A]/30"
                            : "bg-[#111820] text-[#64748b]"
                        }`}
                      >
                        {matchSummary[String(row.id)].count} listings
                      </button>
                    ) : (
                      <span className="text-[10px] text-[#475569]">—</span>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => setSourceParsed(row)} className="text-[10px] font-semibold text-white bg-[#58a6ff] hover:bg-[#4090e0] rounded px-2 py-1">Sources</button>
                      {matchQuery && <a href={`/search?q=${encodeURIComponent(matchQuery)}`} className="text-[10px] font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded px-2 py-1">Match</a>}
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
      {sourceParsed && (
        <SourceDrawer
          parsedId={sourceParsed.id}
          parsed={sourceParsed}
          title={`Source Evidence: ${sourceParsed.broker_name || `Requirement #${sourceParsed.id}`}`}
          onClose={() => setSourceParsed(null)}
        />
      )}
      {matchDrawerId !== null && (
        <MatchDrawer
          requirementId={matchDrawerId}
          onClose={() => setMatchDrawerId(null)}
        />
      )}
    </div>
  );
}
