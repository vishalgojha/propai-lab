"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

export default function GroupsPage() {
  const [groups, setGroups] = useState<any[]>([]);

  useEffect(() => {
    api.getGroups().then(setGroups);
  }, []);

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Groups</h2>
      {groups.length === 0 ? (
        <div className="text-[#64748b]">No groups discovered yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Members</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Messages</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any, i: number) => (
                <tr key={g.id || i} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">{g.name}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{g.member_count ?? "—"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{g.message_count ?? "—"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{g.status ? <span className="badge badge-blue">{g.status}</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
