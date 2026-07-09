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
              <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">ID</th>
              <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Broker</th>
              <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Message</th>
              <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Building</th>
              <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {data.map(r => (
              <tr key={r.id} className="hover:bg-zinc-900">
                <td className="px-2.5 py-2 border-b border-white/10 text-[#58a6ff]">P{r.id}</td>
                <td className="px-2.5 py-2 border-b border-white/10">{r.broker_name || "—"}</td>
                <td className="px-2.5 py-2 border-b border-white/10 max-w-[300px] truncate">{r.location_raw}</td>
                <td className="px-2.5 py-2 border-b border-white/10">{r.building_name || "—"}</td>
                <td className="px-2.5 py-2 border-b border-white/10">
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
