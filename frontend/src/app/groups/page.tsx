"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function GroupsPage() {
  const [groups, setGroups] = useState<any[]>([]);

  useEffect(() => {
    api.getGroups().then(setGroups);
  }, []);
  const parsedGroupCount = groups.filter(g => g.parsed?.is_real_estate || g.parsed?.markets?.length || g.parsed?.segments?.length).length;

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Groups</h2>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          ["Groups", groups.length],
          ["Tagged", parsedGroupCount],
          ["Capture", "Live"],
          ["Window", "10-7"],
        ].map(([label, value]) => (
          <div key={label as string} className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-xl p-3">
            <div className="text-2xl font-bold text-[#e2e8f0]">{value as number | string}</div>
            <div className="text-[10px] uppercase tracking-wider text-[#64748b]">{label as string}</div>
          </div>
        ))}
      </div>
      {groups.length > 0 && (
        <div className="mb-4 border border-[rgba(255,255,255,0.06)] bg-[#0d1117] text-[#94a3b8] rounded-xl px-4 py-3 text-sm">
          PropAI tracks new WhatsApp group activity during 10 AM - 7 PM IST.
        </div>
      )}
      {groups.length === 0 ? (
        <div className="text-[#64748b]">No groups connected yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Tags</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Members</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Mode</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any, i: number) => (
                <tr key={g.id || i} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">{g.name}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <div className="flex flex-wrap gap-1">
                      {[...(g.parsed?.markets || []), ...(g.parsed?.segments || [])].length === 0 ? "—" : [...(g.parsed?.markets || []), ...(g.parsed?.segments || [])].map((tag: string) => <span key={tag} className="badge badge-blue">{tag}</span>)}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{g.participants ?? "—"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]"><span className="badge badge-green">live</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
