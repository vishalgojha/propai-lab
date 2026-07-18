"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Shield, Database, Terminal, Wrench, ArrowLeft, Plus, Smartphone } from "lucide-react";
import { fetchJSON } from "@/lib/api";

interface SuperAdmin {
  id: number;
  user_id: string;
  phone: string;
  email?: string;
  created_at: string;
}

export default function AdminPage() {
  const router = useRouter();
  const [admins, setAdmins] = useState<SuperAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newUserId, setNewUserId] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchAdmins = async () => {
    try {
      const data = await fetchJSON<SuperAdmin[]>("/admin/super-admins");
      setAdmins(data);
    } catch (e) {
      setError("Failed to load super admins");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAdmins(); }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserId.trim()) return;
    setAdding(true);
    try {
      await fetchJSON("/admin/super-admins", {
        method: "POST",
        body: JSON.stringify({ user_id: newUserId.trim(), phone: newPhone.trim() }),
      });
      await fetchAdmins();
      setNewUserId("");
      setNewPhone("");
    } catch (e) {
      alert("Failed to add super admin");
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (userId: string) => {
    if (!confirm("Remove this super admin?")) return;
    try {
      await fetchJSON(`/admin/super-admins/${userId}`, { method: "DELETE" });
      await fetchAdmins();
    } catch (e) {
      alert("Failed to remove super admin");
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-zinc-400 hover:text-white">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white">Admin</h1>
          <p className="text-sm text-zinc-500">Super admin management & developer tools</p>
        </div>
      </div>

      {/* Super Admins */}
      <section className="rounded-2xl border border-white/10 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Shield className="w-5 h-5 text-emerald-400" />
            Super Admins
          </h2>
          <form onSubmit={handleAdd} className="flex items-center gap-2">
            <input
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              placeholder="User ID (UUID)"
              className="px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:border-emerald-400 focus:outline-none w-48"
              required
            />
            <input
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="Phone (optional)"
              className="px-3 py-2 bg-zinc-800 border border-white/10 rounded-lg text-sm text-white placeholder-zinc-500 focus:border-emerald-400 focus:outline-none w-40"
            />
            <button
              type="submit"
              disabled={adding}
              className="px-3 py-2 bg-emerald-400 text-black rounded-lg text-sm font-bold disabled:opacity-50"
            >
              {adding ? "Adding..." : <Plus className="w-4 h-4" />}
            </button>
          </form>
        </div>

        {loading ? (
          <div className="text-center py-8 text-zinc-500">Loading…</div>
        ) : error ? (
          <div className="text-red-400">{error}</div>
        ) : admins.length === 0 ? (
          <div className="text-center py-8 text-zinc-500">No super admins configured</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left px-4 py-3 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">User ID</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Phone</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Email</th>
                  <th className="text-left px-4 py-3 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Created</th>
                  <th className="text-right px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {admins.map((admin) => (
                  <tr key={admin.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-mono text-xs text-zinc-300">{admin.user_id}</td>
                    <td className="px-4 py-3 text-zinc-400">{admin.phone || "—"}</td>
                    <td className="px-4 py-3 text-zinc-400">{admin.email || "—"}</td>
                    <td className="px-4 py-3 text-zinc-500">{admin.created_at?.split("T")[0]}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleRemove(admin.user_id)}
                        className="text-red-400 hover:text-red-300 text-sm font-medium"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Developer Tools */}
      <section className="rounded-2xl border border-white/10 p-6">
        <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
          <Wrench className="w-5 h-5 text-amber-400" />
          Developer Tools
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Link
            href="/admin/whatsapp"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Smartphone className="w-5 h-5 text-emerald-400" />
              <span className="font-medium text-white">WhatsApp Sessions</span>
            </div>
            <p className="text-xs text-zinc-500">Control every workspace phone, connection state, and self-chat assistant</p>
          </Link>

          <Link
            href="/admin/knowledge"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Database className="w-5 h-5 text-emerald-400" />
              <span className="font-medium text-white">Knowledge Records</span>
            </div>
            <p className="text-xs text-zinc-500">Browse extracted knowledge records, search, filter by type</p>
          </Link>

          <Link
            href="/admin/knowledge/observations"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Terminal className="w-5 h-5 text-blue-400" />
              <span className="font-medium text-white">Knowledge Observations</span>
            </div>
            <p className="text-xs text-zinc-500">Inspect entity observations (buildings, prices, feedback, etc.)</p>
          </Link>

          <Link
            href="/admin/extraction"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Shield className="w-5 h-5 text-purple-400" />
              <span className="font-medium text-white">Extraction Logs</span>
            </div>
            <p className="text-xs text-zinc-500">Parser success/failure rates, confidence distribution, error patterns</p>
          </Link>

          <Link
            href="/admin/pipeline"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Wrench className="w-5 h-5 text-amber-400" />
              <span className="font-medium text-white">Pipeline Monitor</span>
            </div>
            <p className="text-xs text-zinc-500">Sync jobs, webhook health, processing queue, backfill status</p>
          </Link>

          <Link
            href="/admin/entities"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Database className="w-5 h-5 text-pink-400" />
              <span className="font-medium text-white">Entity Coverage</span>
            </div>
            <p className="text-xs text-zinc-500">Building/broker/location resolution rates, alias coverage, missing entities</p>
          </Link>

          <Link
            href="/admin/errors"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Shield className="w-5 h-5 text-red-400" />
              <span className="font-medium text-white">Extraction Errors</span>
            </div>
            <p className="text-xs text-zinc-500">Failed parses, low confidence, unrecognized entities, schema mismatches</p>
          </Link>
        </div>
      </section>
    </div>
  );
}
