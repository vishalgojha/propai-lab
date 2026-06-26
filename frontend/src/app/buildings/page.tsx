"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function BuildingsPage() {
  const [buildings, setBuildings] = useState<any[]>([]);

  useEffect(() => {
    api.getBuildings().then(setBuildings);
  }, []);

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Buildings</h2>
      {buildings.length === 0 ? (
        <div className="text-[#64748b]">No building data yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Market</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Developer</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Aliases</th>
              </tr>
            </thead>
            <tbody>
              {buildings.map((b: any, i: number) => (
                <tr key={b.name || i} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">{b.name}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.micro_market || "—"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.developer || "—"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-[#64748b]">{(b.aliases || []).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
