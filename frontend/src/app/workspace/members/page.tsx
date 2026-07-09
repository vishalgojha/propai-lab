"use client";

import React, { useState, useEffect } from "react";
import { Plus, Trash2, Edit2, X } from "lucide-react";

function getAuthHeaders() {
    return {
        "Content-Type": "application/json",
    };
}

function normalizePhone(phone: string): string {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return "+91" + digits;
    if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
    if (digits.length === 13 && digits.startsWith("91")) return "+" + digits.slice(2);
    return phone; // return as-is if can't normalize
}

async function fetchMembers() {
    const res = await fetch("/api/workspace/members", { headers: getAuthHeaders() });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed to fetch members" }));
        throw new Error(err.detail || "Failed to fetch members");
    }
    const data = await res.json();
    return data.members;
}

async function createMember(member: any) {
    const res = await fetch("/api/workspace/members", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(member),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed to create member" }));
        throw new Error(err.detail || "Failed to create member");
    }
    return res.json();
}

async function updateMember(id: number, member: any) {
    const res = await fetch(`/api/workspace/members/${id}`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(member),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed to update member" }));
        throw new Error(err.detail || "Failed to update member");
    }
    return res.json();
}

async function deactivateMember(id: number) {
    const res = await fetch(`/api/workspace/members/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Failed to deactivate member" }));
        throw new Error(err.detail || "Failed to deactivate member");
    }
    return res.json();
}

const PERMISSION_DEFS = [
    { key: "view_inbox", label: "View Market Inbox" },
    { key: "reply_whatsapp", label: "Reply from WhatsApp" },
    { key: "save_requirements", label: "Save Requirements" },
    { key: "save_listings", label: "Save Listings" },
    { key: "export_contacts", "label": "Export Contacts" },
    { key: "view_broker_numbers", "label": "View Broker Numbers" },
    { key: "add_team_members", "label": "Add Team Members" },
    { key: "delete_data", "label": "Delete Data" },
    { key: "ai_actions", "label": "AI Actions" },
    { key: "bulk_broadcast", "label": "Bulk Broadcast" },
];

export default function MembersPage() {
    const [members, setMembers] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [isAdding, setIsAdding] = useState(false);
    const [editingMember, setEditingMember] = useState<any>(null);
    const [newMember, setNewMember] = useState<{
        name: string;
        email: string;
        phone: string;
        role: string;
        permission_keys: string[];
        linked_broker_phone: string;
    }>({
        name: "", email: "", phone: "", role: "member", permission_keys: [], linked_broker_phone: ""
    });

    useEffect(() => {
        loadMembers();
    }, []);

    async function loadMembers() {
        setLoading(true);
        try {
            const data = await fetchMembers();
            setMembers(data);
        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    }

    async function handleAdd() {
        try {
            const memberData = { ...newMember, phone: normalizePhone(newMember.phone) };
            await createMember(memberData);
            setNewMember({ name: "", email: "", phone: "", role: "member", permission_keys: [], linked_broker_phone: "" });
            setIsAdding(false);
            await loadMembers();
        } catch {
            alert("Error adding member");
        }
    }

    async function handleUpdate() {
        try {
            if (!editingMember) return;
            const memberData = { ...editingMember, phone: normalizePhone(editingMember.phone), linked_broker_phone: editingMember.linked_broker_phone ? normalizePhone(editingMember.linked_broker_phone) : "" };
            await updateMember(editingMember.id, memberData);
            setEditingMember(null);
            await loadMembers();
        } catch (error) {
            alert(error instanceof Error ? error.message : "Error updating member");
        }
    }

    async function handleDelete(id: number) {
        if (confirm("Deactivate this team member?")) {
            try {
                await deactivateMember(id);
                await loadMembers();
            } catch (error) {
                alert(error instanceof Error ? error.message : "Error deactivating member");
            }
        }
    }

    const togglePermission = (currentKeys: string[], key: string) => {
        return currentKeys.includes(key)
            ? currentKeys.filter(k => k !== key)
            : [...currentKeys, key];
    };

    const activeMembers = members.filter(m => m.is_active !== 0);
    const inactiveMembers = members.filter(m => m.is_active === 0);

    if (loading) return <div className="p-8 text-gray-400">Loading team members...</div>;

    return (
        <div className="p-8 max-w-6xl mx-auto">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-2xl font-bold text-white">Team Members</h1>
                    <p className="text-gray-400 text-sm">Manage your brokerage team and their permissions</p>
                </div>
                <button 
                    onClick={() => setIsAdding(true)}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                    <Plus size={16} /> Add Member
                </button>
            </div>

            <div className="bg-zinc-900 border border-white/10 rounded-xl overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-[#161b22] text-gray-400 font-medium border-b border-white/10">
                        <tr>
                            <th className="px-4 py-3">Member</th>
                            <th className="px-4 py-3">Role</th>
                            <th className="px-4 py-3">Permissions</th>
                            <th className="px-4 py-3 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgba(255,255,255,0.04)]">
                        {activeMembers.map(m => (
                            <tr key={m.id} className="hover:bg-white/5 transition-colors">
                                <td className="px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-blue-900/30 flex items-center justify-center text-blue-400 font-bold text-xs">
                                            {m.name[0].toUpperCase()}
                                        </div>
                                        <div>
                                            <div className="text-white font-medium">{m.name}</div>
                                            <div className="text-gray-500 text-[11px]">{m.email || m.phone || "No contact info"}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-4 py-3">
                                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                                        m.role === 'owner' ? 'bg-purple-900/30 text-purple-400' : 
                                        m.role === 'admin' ? 'bg-blue-900/30 text-blue-400' : 
                                        'bg-gray-800 text-gray-400'
                                    }`}>
                                        {m.role}
                                    </span>
                                    {m.is_active === 0 && (
                                        <span className="ml-2 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase bg-red-900/30 text-red-400">
                                            Inactive
                                        </span>
                                    )}
                                </td>
                                <td className="px-4 py-3">
                                    <div className="flex flex-wrap gap-1 max-w-xs">
                                        {m.permission_keys.map((k: string) => (
                                            <span key={k} className="px-1.5 py-0.5 bg-[#161b22] border border-[rgba(255,255,255,0.05)] rounded text-[9px] text-gray-400">
                                                {PERMISSION_DEFS.find(d => d.key === k)?.label || k}
                                            </span>
                                        ))}
                                        {m.permission_keys.length === 0 && <span className="text-gray-600 text-[11px]">No permissions</span>}
                                    </div>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    <div className="flex justify-end gap-2">
                                        <button onClick={() => setEditingMember(m)} className="p-1.5 text-gray-400 hover:text-white transition-colors cursor-pointer" title="Edit member">
                                            <Edit2 size={14} />
                                        </button>
                                        <button onClick={() => handleDelete(m.id)} className="p-1.5 text-gray-400 hover:text-red-400 transition-colors cursor-pointer" title="Deactivate member">
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {inactiveMembers.length > 0 && (
                <div className="mt-4 text-xs text-gray-500">
                    {inactiveMembers.length} inactive member{inactiveMembers.length === 1 ? "" : "s"} hidden from the active list.
                </div>
            )}

            {/* Add/Edit Modal */}
            {(isAdding || editingMember) && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl">
                        <div className="px-6 py-4 border-b border-white/10 flex justify-between items-center">
                            <h2 className="text-lg font-bold text-white">{isAdding ? "Add Team Member" : "Edit Member"}</h2>
                            <button onClick={() => { setIsAdding(false); setEditingMember(null); }} className="text-gray-400 hover:text-white">
                                <X size={20} />
                            </button>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-400 font-medium">Full Name *</label>
                                    <input 
                                        type="text" 
                                        className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                                        value={isAdding ? newMember.name : editingMember.name}
                                        onChange={e => isAdding ? setNewMember({...newMember, name: e.target.value}) : setEditingMember({...editingMember, name: e.target.value})}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-400 font-medium">Role</label>
                                    <select 
                                        className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                                        value={isAdding ? newMember.role : editingMember.role}
                                        onChange={e => isAdding ? setNewMember({...newMember, role: e.target.value}) : setEditingMember({...editingMember, role: e.target.value})}
                                    >
                                        <option value="owner">Owner</option>
                                        <option value="admin">Admin</option>
                                        <option value="member">Member</option>
                                        <option value="intern">Intern</option>
                                    </select>
                                </div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-400 font-medium">Email</label>
                                    <input 
                                        type="email" 
                                        className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                                        value={isAdding ? newMember.email : editingMember.email || ""}
                                        onChange={e => isAdding ? setNewMember({...newMember, email: e.target.value}) : setEditingMember({...editingMember, email: e.target.value})}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <label className="text-xs text-gray-400 font-medium">Phone</label>
                                    <input 
                                        type="text" 
                                        className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                                        value={isAdding ? newMember.phone : editingMember.phone || ""}
                                        onChange={e => isAdding ? setNewMember({...newMember, phone: e.target.value}) : setEditingMember({...editingMember, phone: e.target.value})}
                                    />
                                </div>
                            </div>
                            <div className="space-y-1">
                                <label className="text-xs text-gray-400 font-medium">Linked Broker Phone (Optional)</label>
                                <input 
                                    type="text" 
                                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                                    placeholder="e.g. 9892000928"
                                    value={isAdding ? newMember.linked_broker_phone || "" : editingMember.linked_broker_phone || ""}
                                    onChange={e => isAdding ? setNewMember({...newMember, linked_broker_phone: e.target.value}) : setEditingMember({...editingMember, linked_broker_phone: e.target.value})}
                                />
                            </div>
                            <div className="space-y-3">
                                <label className="text-xs text-gray-400 font-medium">Permissions</label>
                                <div className="grid grid-cols-2 gap-2">
                                    {PERMISSION_DEFS.map(p => (
                                        <label key={p.key} className="flex items-center gap-2 p-2 rounded-lg bg-[#161b22] border border-[rgba(255,255,255,0.05)] cursor-pointer hover:bg-[#1c2128] transition-colors">
                                            <input 
                                                type="checkbox" 
                                                className="rounded border-gray-700 bg-gray-900 text-blue-600 focus:ring-0"
                                                checked={ (isAdding ? newMember.permission_keys : editingMember.permission_keys).includes(p.key) }
                                                onChange={() => {
                                                    const keys = togglePermission(isAdding ? newMember.permission_keys : editingMember.permission_keys, p.key);
                                                    if (isAdding) setNewMember({...newMember, permission_keys: keys});
                                                    else setEditingMember({...editingMember, permission_keys: keys});
                                                }}
                                            />
                                            <span className="text-xs text-gray-300">{p.label}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="px-6 py-4 bg-[#161b22] border-t border-white/10 flex justify-end gap-3">
                            <button 
                                onClick={() => { setIsAdding(false); setEditingMember(null); }}
                                className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={isAdding ? handleAdd : handleUpdate}
                                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
                            >
                                {isAdding ? "Create Member" : "Save Changes"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
