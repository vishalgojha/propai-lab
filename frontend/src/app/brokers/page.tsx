"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function BrokersPage() {
  const [brokers, setBrokers] = useState<any[]>([]);

  useEffect(() => {
    api.getBrokers().then(setBrokers);
  }, []);

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Brokers</h2>
      {brokers.length === 0 ? (
        <div className="text-[#64748b]">No broker data yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Phone</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Messages</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Groups</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b: any, i: number) => (
                <tr key={b.name || i} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">{b.name}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-[#64748b]">{b.phone}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.message_count}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.group_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
