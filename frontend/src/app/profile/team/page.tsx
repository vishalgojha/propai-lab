"use client";

import React, { useState, useEffect } from "react";
import { Plus, Trash2, Edit2, X, Shield } from "lucide-react";

function getAuthHeaders() {
  return { "Content-Type": "application/json" };
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return "+91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
  if (digits.length === 13 && digits.startsWith("91")) return "+" + digits.slice(2);
  return phone;
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
    method: "POST", headers: getAuthHeaders(),
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
    method: "PUT", headers: getAuthHeaders(),
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
    method: "DELETE", headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to deactivate member" }));
    throw new Error(err.detail || "Failed to deactivate member");
  }
  return res.json();
}

async function fetchRoles() {
  const res = await fetch("/api/workspace/roles", { headers: getAuthHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return data.roles || [];
}

async function createRole(name: string, permission_keys: string[]) {
  const res = await fetch("/api/workspace/roles", {
    method: "POST", headers: getAuthHeaders(),
    body: JSON.stringify({ name, permission_keys }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to create role" }));
    throw new Error(err.detail || "Failed to create role");
  }
  return res.json();
}

async function updateRole(roleId: number, data: { name?: string; permission_keys?: string[] }) {
  const res = await fetch(`/api/workspace/roles/${roleId}`, {
    method: "PUT", headers: getAuthHeaders(),
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to update role" }));
    throw new Error(err.detail || "Failed to update role");
  }
  return res.json();
}

async function deleteRole(roleId: number) {
  const res = await fetch(`/api/workspace/roles/${roleId}`, {
    method: "DELETE", headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: "Failed to delete role" }));
    throw new Error(err.detail || "Failed to delete role");
  }
  return res.json();
}

const PERMISSION_DEFS = [
  { key: "view_inbox", label: "View Market Inbox" },
  { key: "reply_whatsapp", label: "Reply from WhatsApp" },
  { key: "save_requirements", label: "Save Requirements" },
  { key: "save_listings", label: "Save Listings" },
  { key: "export_contacts", label: "Export Contacts" },
  { key: "view_broker_numbers", label: "View Broker Numbers" },
  { key: "add_team_members", label: "Add Team Members" },
  { key: "delete_data", label: "Delete Data" },
  { key: "ai_actions", label: "AI Actions" },
  { key: "bulk_broadcast", label: "Bulk Broadcast" },
];

function PermissionCheckboxes({ keys, onChange }: { keys: string[]; onChange: (keys: string[]) => void }) {
  const toggle = (key: string) => {
    onChange(keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key]);
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      {PERMISSION_DEFS.map(p => (
        <label key={p.key} className="flex items-center gap-2 p-2 rounded-lg bg-[#161b22] border border-[rgba(255,255,255,0.05)] cursor-pointer hover:bg-[#1c2128] transition-colors">
          <input type="checkbox" className="rounded border-gray-700 bg-gray-900 text-blue-600 focus:ring-0"
            checked={keys.includes(p.key)} onChange={() => toggle(p.key)} />
          <span className="text-xs text-gray-300">{p.label}</span>
        </label>
      ))}
    </div>
  );
}

export default function MembersPage() {
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"members" | "roles">("members");

  // Member modal state
  const [isAdding, setIsAdding] = useState(false);
  const [editingMember, setEditingMember] = useState<any>(null);
  const [newMember, setNewMember] = useState({
    name: "", email: "", phone: "", role: "member", permission_keys: [] as string[], linked_broker_phone: "",
  });

  // Role modal state
  const [roles, setRoles] = useState<any[]>([]);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);
  const [roleName, setRoleName] = useState("");
  const [rolePerms, setRolePerms] = useState<string[]>([]);

  useEffect(() => { loadMembers(); loadRoles(); }, []);

  async function loadMembers() {
    setLoading(true);
    try { setMembers(await fetchMembers()); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  }

  async function loadRoles() {
    try { setRoles(await fetchRoles()); }
    catch (e) { console.error(e); }
  }

  async function handleAdd() {
    try {
      await createMember({ ...newMember, phone: normalizePhone(newMember.phone) });
      setNewMember({ name: "", email: "", phone: "", role: "member", permission_keys: [], linked_broker_phone: "" });
      setIsAdding(false);
      await loadMembers();
    } catch { alert("Error adding member"); }
  }

  async function handleUpdate() {
    try {
      if (!editingMember) return;
      const data = {
        ...editingMember,
        phone: normalizePhone(editingMember.phone),
        linked_broker_phone: editingMember.linked_broker_phone ? normalizePhone(editingMember.linked_broker_phone) : "",
      };
      await updateMember(editingMember.id, data);
      setEditingMember(null);
      await loadMembers();
    } catch (e) { alert(e instanceof Error ? e.message : "Error updating member"); }
  }

  async function handleDelete(id: number) {
    if (confirm("Deactivate this team member?")) {
      try { await deactivateMember(id); await loadMembers(); }
      catch (e) { alert(e instanceof Error ? e.message : "Error deactivating member"); }
    }
  }

  function handleSelectRole(roleSlug: string, setKeys: (keys: string[]) => void) {
    const r = roles.find(r => r.name === roleSlug);
    if (r) {
      const keys = typeof r.permission_keys === "string" ? JSON.parse(r.permission_keys) : r.permission_keys;
      setKeys(Array.isArray(keys) ? keys : []);
    }
  }

  async function handleSaveRole() {
    if (!roleName.trim()) return;
    try {
      if (editingRole) {
        await updateRole(editingRole.id, { name: roleName.trim(), permission_keys: rolePerms });
      } else {
        await createRole(roleName.trim(), rolePerms);
      }
      setShowRoleModal(false);
      setEditingRole(null);
      setRoleName("");
      setRolePerms([]);
      await loadRoles();
    } catch (e) { alert(e instanceof Error ? e.message : "Error saving role"); }
  }

  async function handleDeleteRole(role: any) {
    if (role.is_system) { alert("Cannot delete system roles"); return; }
    if (confirm(`Delete role "${role.name}"?`)) {
      try { await deleteRole(role.id); await loadRoles(); }
      catch (e) { alert(e instanceof Error ? e.message : "Error deleting role"); }
    }
  }

  const activeMembers = members.filter(m => m.is_active !== 0);
  const inactiveCount = members.filter(m => m.is_active === 0).length;

  if (loading) return <div className="p-8 text-gray-400">Loading team members...</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Team</h1>
          <p className="text-gray-400 text-sm">Manage your brokerage team, roles, and permissions</p>
        </div>
        <div className="flex gap-3">
          {tab === "roles" && (
            <button onClick={() => { setEditingRole(null); setRoleName(""); setRolePerms([]); setShowRoleModal(true); }}
              className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Plus size={16} /> Create Role
            </button>
          )}
          {tab === "members" && (
            <button onClick={() => setIsAdding(true)}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              <Plus size={16} /> Add Member
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-zinc-900 border border-white/10 rounded-xl p-1 w-fit">
        <button onClick={() => setTab("members")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === "members" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-white"}`}>
          Members
        </button>
        <button onClick={() => setTab("roles")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${tab === "roles" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-white"}`}>
          Roles
        </button>
      </div>

      {/* ─── Members Tab ─── */}
      {tab === "members" && (
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
                      m.role === "owner" ? "bg-purple-900/30 text-purple-400" :
                      m.role === "admin" ? "bg-blue-900/30 text-blue-400" :
                      "bg-gray-800 text-gray-400"
                    }`}>{m.role}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {(m.permission_keys || []).map((k: string) => (
                        <span key={k} className="px-1.5 py-0.5 bg-[#161b22] border border-[rgba(255,255,255,0.05)] rounded text-[9px] text-gray-400">
                          {PERMISSION_DEFS.find(d => d.key === k)?.label || k}
                        </span>
                      ))}
                      {(!m.permission_keys || m.permission_keys.length === 0) && <span className="text-gray-600 text-[11px]">No permissions</span>}
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
          {inactiveCount > 0 && <div className="px-4 py-2 text-xs text-gray-500 border-t border-white/5">{inactiveCount} inactive member{inactiveCount === 1 ? "" : "s"}</div>}
        </div>
      )}

      {/* ─── Roles Tab ─── */}
      {tab === "roles" && (
        <div className="space-y-3">
          {roles.length === 0 && <p className="text-sm text-zinc-500">No roles defined yet.</p>}
          {roles.map(r => {
            const keys = typeof r.permission_keys === "string" ? JSON.parse(r.permission_keys) : (r.permission_keys || []);
            return (
              <div key={r.id} className="bg-zinc-900 border border-white/10 rounded-xl p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <Shield className="w-5 h-5 text-zinc-400" />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white">{r.name}</span>
                        {r.is_system && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-zinc-800 text-zinc-500">System</span>}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-2">
                        {Array.isArray(keys) && keys.map((k: string) => (
                          <span key={k} className="px-1.5 py-0.5 bg-[#161b22] border border-[rgba(255,255,255,0.05)] rounded text-[9px] text-gray-400">
                            {PERMISSION_DEFS.find(d => d.key === k)?.label || k}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  {!r.is_system && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { setEditingRole(r); setRoleName(r.name); setRolePerms(keys); setShowRoleModal(true); }}
                        className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Edit role">
                        <Edit2 size={14} />
                      </button>
                      <button onClick={() => handleDeleteRole(r)} className="p-1.5 text-gray-400 hover:text-red-400 transition-colors" title="Delete role">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Add/Edit Member Modal ─── */}
      {(isAdding || editingMember) && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex justify-between items-center">
              <h2 className="text-lg font-bold text-white">{isAdding ? "Add Team Member" : "Edit Member"}</h2>
              <button onClick={() => { setIsAdding(false); setEditingMember(null); }} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Full Name *</label>
                  <input type="text"
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    value={isAdding ? newMember.name : editingMember.name}
                    onChange={e => isAdding ? setNewMember({...newMember, name: e.target.value}) : setEditingMember({...editingMember, name: e.target.value})} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Role</label>
                  <select
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    value={isAdding ? newMember.role : editingMember.role}
                    onChange={e => {
                      const val = e.target.value;
                      if (isAdding) {
                        setNewMember({...newMember, role: val});
                        handleSelectRole(val, (keys) => setNewMember(prev => ({...prev, permission_keys: keys})));
                      } else {
                        setEditingMember({...editingMember, role: val});
                        handleSelectRole(val, (keys) => setEditingMember((prev: any) => ({...prev, permission_keys: keys})));
                      }
                    }}>
                    {roles.map(r => <option key={r.id} value={r.name}>{r.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Email</label>
                  <input type="email"
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    value={isAdding ? newMember.email : (editingMember.email || "")}
                    onChange={e => isAdding ? setNewMember({...newMember, email: e.target.value}) : setEditingMember({...editingMember, email: e.target.value})} />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-gray-400 font-medium">Phone</label>
                  <input type="text"
                    className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                    value={isAdding ? newMember.phone : (editingMember.phone || "")}
                    onChange={e => isAdding ? setNewMember({...newMember, phone: e.target.value}) : setEditingMember({...editingMember, phone: e.target.value})} />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-gray-400 font-medium">Linked Broker Phone (Optional)</label>
                <input type="text"
                  className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="e.g. 9892000928"
                  value={isAdding ? (newMember.linked_broker_phone || "") : (editingMember.linked_broker_phone || "")}
                  onChange={e => isAdding ? setNewMember({...newMember, linked_broker_phone: e.target.value}) : setEditingMember({...editingMember, linked_broker_phone: e.target.value})} />
              </div>
              <div className="space-y-3">
                <label className="text-xs text-gray-400 font-medium">Permissions</label>
                <PermissionCheckboxes
                  keys={isAdding ? newMember.permission_keys : editingMember.permission_keys}
                  onChange={keys => isAdding ? setNewMember({...newMember, permission_keys: keys}) : setEditingMember({...editingMember, permission_keys: keys})} />
              </div>
            </div>
            <div className="px-6 py-4 bg-[#161b22] border-t border-white/10 flex justify-end gap-3">
              <button onClick={() => { setIsAdding(false); setEditingMember(null); }} className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={isAdding ? handleAdd : handleUpdate} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors">
                {isAdding ? "Create Member" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Create/Edit Role Modal ─── */}
      {showRoleModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-white/10 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl">
            <div className="px-6 py-4 border-b border-white/10 flex justify-between items-center">
              <h2 className="text-lg font-bold text-white">{editingRole ? "Edit Role" : "Create Custom Role"}</h2>
              <button onClick={() => { setShowRoleModal(false); setEditingRole(null); }} className="text-gray-400 hover:text-white"><X size={20} /></button>
            </div>
            <div className="p-6 space-y-6">
              <div className="space-y-1">
                <label className="text-xs text-gray-400 font-medium">Role Name</label>
                <input type="text" value={roleName} onChange={e => setRoleName(e.target.value)}
                  className="w-full bg-[#161b22] border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 transition-colors"
                  placeholder="e.g. Senior Agent, Team Lead" />
              </div>
              <div className="space-y-3">
                <label className="text-xs text-gray-400 font-medium">Permissions</label>
                <PermissionCheckboxes keys={rolePerms} onChange={setRolePerms} />
              </div>
            </div>
            <div className="px-6 py-4 bg-[#161b22] border-t border-white/10 flex justify-end gap-3">
              <button onClick={() => { setShowRoleModal(false); setEditingRole(null); }} className="px-4 py-2 text-sm font-medium text-gray-400 hover:text-white transition-colors">Cancel</button>
              <button onClick={handleSaveRole} disabled={!roleName.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                {editingRole ? "Save Changes" : "Create Role"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
