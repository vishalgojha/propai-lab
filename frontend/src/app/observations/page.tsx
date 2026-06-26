"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function ObservationsPage() {
  const [data, setData] = useState<api.ParsedObservation[]>([]);
  const [offset, setOffset] = useState(0);

  useEffect(() => { api.getParsed(50, offset).then(setData); }, [offset]);

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Observations</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">ID</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Broker</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Message</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Building</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {data.map(r => (
              <tr key={r.id} className="hover:bg-[#0d1117]">
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-[#58a6ff]">P{r.id}</td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.broker_name || "—"}</td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] max-w-[300px] truncate">{r.location_raw}</td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.building_name || "—"}</td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                  {r.confidence != null && <span className={`badge ${r.confidence > 0.7 ? "badge-green" : r.confidence > 0.3 ? "badge-yellow" : "badge-red"}`}>{(r.confidence * 100).toFixed(0)}%</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
