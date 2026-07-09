"use client";

import React, { useState, useEffect } from "react";
import { Phone, ShieldCheck, ShieldAlert, Save, RefreshCcw } from "lucide-react";

async function fetchAccess() {
    const res = await fetch("/api/workspace/whatsapp-access");
    if (!res.ok) throw new Error("Failed to fetch access");
    const data = await res.json();
    return data.access;
}

async function setAccess(payload: any) {
    const res = await fetch("/api/workspace/whatsapp-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Failed to update access");
    return res.json();
}

export default function WhatsappAccessPage() {
    const [accessList, setAccessList] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadAccess();
    }, []);

    async function loadAccess() {
        setLoading(true);
        try {
            const data = await fetchAccess();
            setAccessList(data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }

    async function handleToggleSend(id: number, memberId: number, phone: string, current: boolean) {
        setSaving(true);
        try {
            await setAccess({
                team_member_id: memberId,
                whatsapp_number: phone,
                can_send: !current,
                can_view_messages: true,
            });
            await loadAccess();
        } catch (e) {
            alert("Error updating send permission");
        } finally {
            setSaving(false);
        }
    }

    if (loading) return <div className="p-8 text-gray-400">Loading WhatsApp access...</div>;

    return (
        <div className="p-8 max-w-4xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-white">WhatsApp Access Control</h1>
                    <p className="text-gray-400 text-sm">Define who can send messages through connected numbers</p>
                </div>
                <button 
                    onClick={loadAccess}
                    className="flex items-center gap-2 bg-[#161b22] border border-white/10 text-gray-400 hover:text-white px-3 py-1.5 rounded-lg text-xs transition-colors"
                >
                    <RefreshCcw size={14} /> Refresh
                </button>
            </div>

            <div className="grid gap-4">
                {accessList.length === 0 ? (
                    <div className="bg-zinc-900 border border-white/10 rounded-xl p-12 text-center text-gray-500">
                        No WhatsApp access rules defined.
                    </div>
                ) : (
                    accessList.map(acc => (
                        <div key={acc.id} className="bg-zinc-900 border border-white/10 rounded-xl p-4 flex items-center justify-between hover:border-blue-500/30 transition-colors">
                            <div className="flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-blue-900/20 flex items-center justify-center text-blue-400">
                                    <Phone size={18} />
                                </div>
                                <div>
                                    <div className="text-white font-medium">{acc.member_name}</div>
                                    <div className="text-gray-500 text-xs font-mono">{acc.whatsapp_number}</div>
                                </div>
                            </div>
                            <div className="flex items-center gap-6">
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Can Send</span>
                                    <button 
                                        onClick={() => handleToggleSend(acc.id, acc.team_member_id, acc.whatsapp_number, !!acc.can_send)}
                                        disabled={saving}
                                        className={`p-1 rounded transition-colors ${acc.can_send ? 'text-green-400 bg-green-400/10' : 'text-gray-600 bg-gray-800'}`}
                                    >
                                        {acc.can_send ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
                                    </button>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">Can View</span>
                                    <div className={`p-1 rounded ${acc.can_view_messages ? 'text-green-400 bg-green-400/10' : 'text-gray-600 bg-gray-800'}`}>
                                        <ShieldCheck size={18} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
