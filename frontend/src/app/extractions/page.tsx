"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

const PAGE_SIZE = 50;

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
        <table className="w-full text-sm">
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
            </tr>
          </thead>
          <tbody>
            {data.map(r => {
              const pct = r.confidence ? (r.confidence * 100) : 0;
              const cColor = pct >= 70 ? "green" : pct >= 40 ? "yellow" : "red";
              const phone = (r.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
              const waLink = phone.length === 10 ? `https://wa.me/91${phone}` : "";
              return (
                <tr key={r.id} className="hover:bg-[#0d1117]">
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                  <a href={`/observations/${r.raw_message_id}`} className="text-[#58a6ff] font-semibold no-underline hover:underline">P{r.id}</a>
                  <div className="text-[10px] text-[#64748b]">{r.raw_group}</div>
                </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">
                    {r.broker_name || "—"}
                    {waLink && <div><a href={waLink} target="_blank" className="text-[10px] text-[#3b82f6] no-underline">wa.me/{phone}</a></div>}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    {r.intent && <span className={`badge ${({ SELL: "badge-green", BUY: "badge-purple", RENT: "badge-yellow", COMMERCIAL: "badge-orange", "PRE-LAUNCH": "badge-red" } as Record<string, string>)[r.intent] || "badge-blue"}`}>{r.intent}</span>}
                    {r.intent && <span className="prov prov-parsed">Parsed</span>}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.bhk}{r.bhk && <span className="prov prov-parsed">Parsed</span>}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.price ? `${r.price.toLocaleString()} ${r.price_unit || ""}` : ""}{r.price ? <span className="prov prov-parsed">Parsed</span> : ""}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.area_sqft ? `${r.area_sqft.toLocaleString()} sqft` : ""}{r.area_sqft ? <span className="prov prov-parsed">Parsed</span> : ""}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] max-w-[200px] truncate">
                    {r.location_raw}
                    {r.location?.tokens && (
                      <div className="text-[10px] text-[#58a6ff] mt-0.5">
                        {r.location.tokens.map((t, i) => (
                          <span key={i} className="loc-token">{t.text} <small className="text-[#64748b]">{t.kind}</small></span>
                        ))}
                      </div>
                    )}
                    {r.location_raw && <span className="prov prov-parsed">Parsed</span>}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] max-w-[120px] truncate">{r.landmark_name}{r.landmark_name && <span className="prov prov-enriched">Enriched</span>}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.micro_market}{r.micro_market && <span className="prov prov-enriched">Enriched</span>}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]"><span className={`badge badge-${cColor}`}>{pct.toFixed(0)}%</span></td>
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
