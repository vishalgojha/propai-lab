"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function MarketsPage() {
  const [heatmap, setHeatmap] = useState<any[]>([]);
  const [coverage, setCoverage] = useState<api.DashboardCoverage | null>(null);

  useEffect(() => {
    Promise.all([api.getDashboardHeatmap(), api.getDashboardCoverage()]).then(([h, c]) => {
      setHeatmap(h);
      setCoverage(c);
    });
  }, []);

  const max = heatmap.length > 0 ? heatmap[0].c : 1;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-bold">Markets</h2>

      <div className="grid grid-cols-4 gap-3">
        {[
          ["Micro Markets", coverage?.micro_markets_known],
          ["Buildings", coverage?.buildings_known],
          ["Landmarks", coverage?.landmarks_known],
          ["Developers", coverage?.developers_known],
        ].map(([l, v]) => (
          <div key={l as string} className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-4 text-center">
            <div className="text-3xl font-bold text-[#e2e8f0]">{v ?? "—"}</div>
            <div className="text-[10px] text-[#64748b] uppercase tracking-wider mt-1">{l as string}</div>
          </div>
        ))}
      </div>

      <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
        <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-3">ACTIVITY BY MARKET</div>
        {heatmap.length === 0 ? (
          <div className="text-[#64748b] text-center py-5">No data yet</div>
        ) : (
          heatmap.map((h, i) => (
            <div key={i} className="heat-row">
              <span className="heat-name">{h.micro_market}</span>
              <div className="heat-bar"><div className="heat-fill" style={{ width: `${Math.max(3, (h.c / max) * 100)}%` }}></div></div>
              <span className="heat-count">{h.c}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
