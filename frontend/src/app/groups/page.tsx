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
          <div key={label as string} className="bg-zinc-900 border border-white/10 rounded-xl p-3">
            <div className="text-2xl font-bold text-white">{value as number | string}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label as string}</div>
          </div>
        ))}
      </div>
      {groups.length > 0 && (
        <div className="mb-4 border border-white/10 bg-zinc-900 text-zinc-400 rounded-xl px-4 py-3 text-sm">
          PropAI tracks new WhatsApp group activity during 10 AM - 7 PM IST.
        </div>
      )}
      {groups.length === 0 ? (
        <div className="text-zinc-500">No groups connected yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Tags</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Members</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Mode</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any, i: number) => (
                <tr key={g.id || i} className="hover:bg-zinc-900">
                  <td className="px-2.5 py-2 border-b border-white/10 font-semibold">{g.name}</td>
                  <td className="px-2.5 py-2 border-b border-white/10">
                    <div className="flex flex-wrap gap-1">
                      {[...(g.parsed?.markets || []), ...(g.parsed?.segments || [])].length === 0 ? "—" : [...(g.parsed?.markets || []), ...(g.parsed?.segments || [])].map((tag: string) => <span key={tag} className="badge badge-blue">{tag}</span>)}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-white/10">{g.participants ?? "—"}</td>
                  <td className="px-2.5 py-2 border-b border-white/10"><span className="badge badge-green">live</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
