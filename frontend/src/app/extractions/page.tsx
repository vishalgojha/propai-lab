"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

const PAGE_SIZE = 50;

function formatPrice(value?: number | null) {
  if (!value) return "";
  if (value >= 10000000) {
    return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (value >= 100000) {
    return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} K`;
  }
  return value.toLocaleString("en-IN");
}

function intentClass(intent: string) {
  return ({
    SELL: "badge-green",
    SELLER: "badge-green",
    BUY: "badge-purple",
    BUYER: "badge-purple",
    REQUIREMENT: "badge-purple",
    RENT: "badge-yellow",
    RENTAL: "badge-yellow",
    RENTAL_SEEKER: "badge-yellow",
    COMMERCIAL: "badge-orange",
    COMMERCIAL_SALE: "badge-orange",
    COMMERCIAL_RENTAL: "badge-orange",
    "PRE-LAUNCH": "badge-red",
  } as Record<string, string>)[intent] || "badge-blue";
}

function locationQuery(r: api.ParsedObservation): string {
  return [r.building_name, r.landmark_name, r.micro_market, r.location_raw].filter(Boolean).join(" ");
}

function demandQuery(r: api.ParsedObservation): string {
  return [
    "requirement",
    r.bhk,
    r.micro_market || r.location_raw,
    r.landmark_name && `near ${r.landmark_name}`,
    r.price && `under ${formatPrice(r.price)}`,
  ].filter(Boolean).join(" ");
}

function brokerQuery(r: api.ParsedObservation): string {
  return r.broker_phone || r.broker_name || "";
}

function whatsappLink(r: api.ParsedObservation): string {
  const phone = (r.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (phone.length !== 10) return "";
  const intro = [
    r.bhk,
    r.intent ? r.intent.toLowerCase() : "property",
    r.micro_market || r.location_raw,
    r.price ? formatPrice(r.price) : "",
  ].filter(Boolean).join(" ");
  const text = `Hi, I saw your ${intro || "property"} update. Is it still available?`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

export default function ExtractionsPage() {
  const [data, setData] = useState<api.ParsedObservation[]>([]);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    api.getParsed(PAGE_SIZE, offset).then(setData);
  }, [offset]);

  return (
    <div>
      <div className="flex gap-2 mb-4">
        <button onClick={() => api.getParsed(PAGE_SIZE, offset).then(setData)} className="px-3 py-1.5 bg-[#3EE88A] text-[#04100a] rounded-lg text-sm font-bold">Refresh</button>
      </div>
      <div className="overflow-x-auto">
        <table className="data-table text-sm">
          <thead>
            <tr>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">ID</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Broker</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Type</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">BHK</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Price</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Area</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Location</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Landmark</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Market</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Conf.</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map(r => {
              const pct = r.confidence ? (r.confidence * 100) : 0;
              const cColor = pct >= 70 ? "green" : pct >= 40 ? "yellow" : "red";
              const waLink = whatsappLink(r);
              return (
                <tr key={r.id} className="hover:bg-[#0d1117]">
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                  <a href={`/observations/${r.raw_message_id}`} className="text-[#58a6ff] font-semibold no-underline hover:underline">P{r.id}</a>
                  <div className="text-[10px] text-[#64748b]">{r.raw_group}</div>
                </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">
                    <div className="broker-cell">
                      <span>{r.broker_name || "-"}</span>
                      {waLink && <a href={waLink} target="_blank" rel="noreferrer" className="wa-icon" title="Message on WhatsApp" aria-label="Message on WhatsApp">WA</a>}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    {r.intent && <span className={`badge ${intentClass(r.intent)}`}>{r.intent}</span>}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.bhk}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{formatPrice(r.price)}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.area_sqft ? `${r.area_sqft.toLocaleString()} sqft` : ""}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[260px] max-w-[420px] break-words">
                    {r.location_raw}
                    {r.location?.tokens && (
                      <div className="text-[10px] text-[#58a6ff] mt-0.5">
                        {r.location.tokens.map((t, i) => (
                          <span key={i} className="loc-token">{t.text} <small className="text-[#64748b]">{t.kind}</small></span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[180px] max-w-[300px] break-words">{r.landmark_name}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[140px]">{r.micro_market}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]"><span className={`badge badge-${cColor}`}>{pct.toFixed(0)}%</span></td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[190px]">
                    <div className="flex flex-wrap gap-2">
                      <a href={`/observations/${r.raw_message_id}`} className="text-xs font-semibold text-[#58a6ff] hover:underline">View</a>
                      <a href={`/search?q=${encodeURIComponent(demandQuery(r))}`} className="text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg px-2.5 py-1">Find demand</a>
                      {brokerQuery(r) && <a href={`/search?q=${encodeURIComponent(brokerQuery(r))}`} className="text-xs font-semibold text-[#64748b] hover:text-[#e2e8f0]">Broker</a>}
                      {locationQuery(r) && <a href={`/search?q=${encodeURIComponent(locationQuery(r))}`} className="text-xs font-semibold text-[#64748b] hover:text-[#e2e8f0]">Market</a>}
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
        <span className="text-sm text-[#64748b]">{data.length > 0 ? `${offset + 1}–${offset + data.length}` : "0"}</span>
        <button disabled={data.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)} className="px-3 py-1 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm disabled:opacity-40">Next</button>
      </div>
    </div>
  );
}
