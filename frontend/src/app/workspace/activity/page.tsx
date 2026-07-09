"use client";

import React, { useState, useEffect } from "react";
import { Search, Calendar, User, Filter, ChevronLeft, ChevronRight } from "lucide-react";

async function fetchActivity(limit: number, offset: number, action: string | null, memberId: number | null) {
    const params = new URLSearchParams();
    params.set("limit", limit.toString());
    params.set("offset", offset.toString());
    if (action) params.set("action", action);
    if (memberId) params.set("team_member_id", memberId.toString());
    
    const res = await fetch(`/api/workspace/activity?${params.toString()}`);
    if (!res.ok) throw new Error("Failed to fetch activity");
    return res.json();
}

export default function ActivityPage() {
    const [activity, setActivity] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [limit, setLimit] = useState(50);
    const [offset, setOffset] = useState(0);
    const [actionFilter, setActionFilter] = useState("");
    const [memberFilter, setMemberFilter] = useState("");

    useEffect(() => {
        loadActivity();
    }, [offset, actionFilter, memberFilter]);

    async function loadActivity() {
        setLoading(true);
        try {
            const data = await fetchActivity(limit, offset, actionFilter || null, memberFilter ? parseInt(memberFilter) : null);
            setActivity(data.activity);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="p-8 max-w-6xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-white">Activity Log</h1>
                    <p className="text-gray-400 text-sm">Audit trail of all team actions</p>
                </div>
                <div className="flex gap-3">
                    <div className="relative">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                        <input 
                            type="text"
                            placeholder="Filter by action..."
                            className="bg-[#161b22] border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors w-64"
                            value={actionFilter}
                            onChange={e => { setActionFilter(e.target.value); setOffset(0); }}
                        />
                    </div>
                </div>
            </div>

            <div className="bg-zinc-900 border border-white/10 rounded-xl overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-[#161b22] text-gray-400 font-medium border-b border-white/10">
                        <tr>
                            <th className="px-4 py-3">Timestamp</th>
                            <th className="px-4 py-3">Member</th>
                            <th className="px-4 py-3">Action</th>
                            <th className="px-4 py-3">Target</th>
                            <th className="px-4 py-3">Details</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                        {loading ? (
                            <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">Loading activity...</td></tr>
                        ) : activity.length === 0 ? (
                            <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No activity recorded</td></tr>
                        ) : (
                            activity.map(log => (
                                <tr key={log.id} className="hover:bg-white/5 transition-colors">
                                    <td className="px-4 py-3 text-gray-500 text-[11px] font-mono">
                                        {new Date(log.created_at).toLocaleString()}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center text-gray-400 font-bold text-[10px]">
                                                {log.member_name?.[0]?.toUpperCase() || "?"}
                                            </div>
                                            <span className="text-white text-xs font-medium">{log.member_name}</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3">
                                        <span className="px-2 py-0.5 bg-blue-900/20 text-blue-400 rounded text-[10px] font-bold uppercase">
                                            {log.action.replace(/_/g, " ")}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-gray-300 text-xs">
                                        <span className="text-gray-500 mr-1">{log.target_type}:</span> {log.target_id}
                                    </td>
                                    <td className="px-4 py-3 text-gray-500 text-[11px] italic">
                                        {log.details ? JSON.stringify(JSON.parse(log.details)) : "—"}
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
                <div className="px-4 py-3 border-t border-white/10 flex justify-between items-center bg-[#161b22]">
                    <span className="text-xs text-gray-500">Showing {offset + 1} - {Math.min(offset + limit, activity.length)} of {activity.length}</span>
                    <div className="flex gap-2">
                        <button 
                            onClick={() => setOffset(Math.max(0, offset - limit))}
                            disabled={offset === 0}
                            className="p-1.5 rounded bg-zinc-900 border border-white/10 text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
                        >
                            <ChevronLeft size={16} />
                        </button>
                        <button 
                            onClick={() => setOffset(offset + limit)}
                            disabled={activity.length <= offset + limit}
                            className="p-1.5 rounded bg-zinc-900 border border-white/10 text-gray-400 hover:text-white disabled:opacity-30 transition-colors"
                        >
                            <ChevronRight size={16} />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
