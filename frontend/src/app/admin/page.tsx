"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import Link from "next/link";
import { Shield, Wrench, ArrowLeft, Plus, Smartphone, Activity } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { useAuth } from "@/lib/AuthProvider";

interface SuperAdmin {
  id: number;
  user_id: string;
  phone: string;
  email?: string;
  created_at: string;
}

export default function AdminPage() {
  const { user } = useAuth();
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
    <div className="mx-auto max-w-5xl p-6 lg:p-8">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <p className="propai-kicker text-[10px] font-semibold">Platform operations</p>
          <h1 className="mt-1 text-2xl font-semibold leading-tight tracking-[-0.03em] text-[var(--text-primary)] sm:text-3xl sm:tracking-[-0.035em]">Admin</h1>
          <p className="text-sm text-[var(--text-secondary)]">Super admin management and platform operations</p>
        </div>
      </div>

      {/* Super Admins */}
      <section className="propai-panel mb-6 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
            <Shield className="h-5 w-5 text-[var(--signal-lime)]" />
            Super Admins
          </h2>
          <form onSubmit={handleAdd} className="flex items-center gap-2">
            <input
              value={newUserId}
              onChange={(e) => setNewUserId(e.target.value)}
              placeholder="User ID (UUID)"
              className="w-48 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] focus:border-[var(--monsoon-teal)]"
              required
            />
            <input
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="Phone (optional)"
              className="w-40 rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)] focus:border-[var(--monsoon-teal)]"
            />
            <button
              type="submit"
              disabled={adding}
              className="rounded-lg bg-[var(--signal-lime)] px-3 py-2 text-sm font-bold text-[var(--asphalt)] disabled:opacity-50"
            >
              {adding ? "Adding..." : <Plus className="w-4 h-4" />}
            </button>
          </form>
        </div>

        {loading ? (
          <div className="py-8 text-center text-[var(--text-secondary)]">Loading…</div>
        ) : error ? (
          <div className="text-red-400">{error}</div>
        ) : admins.length === 0 ? (
          <div className="py-8 text-center text-[var(--text-secondary)]">No super admins configured</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">User ID</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">Phone</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">Email</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">Created</th>
                  <th className="text-right px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {admins.map((admin, index) => {
                  const isPrimary = index === 0;
                  const isCurrentUser = admin.user_id === user?.id;
                  return (
                  <tr key={admin.id} className="border-b border-[var(--border)] hover:bg-[var(--surface-raised)]">
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-primary)]">{admin.user_id}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{admin.phone || "—"}</td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">{admin.email || "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--text-secondary)]">{admin.created_at?.split("T")[0]}</td>
                    <td className="px-4 py-3 text-right">
                      {isPrimary || isCurrentUser ? (
                        <span className="text-xs font-medium text-[var(--text-secondary)]" title={isPrimary ? "The primary super admin cannot be removed" : "The currently signed-in admin cannot be removed"}>
                          {isPrimary ? "Primary admin" : "Current admin"}
                        </span>
                      ) : (
                        <button
                          onClick={() => handleRemove(admin.user_id)}
                          className="text-red-400 hover:text-red-300 text-sm font-medium"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Platform operations */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <h2 className="mb-4 flex items-center gap-2 text-lg font-bold text-[var(--text-primary)]">
          <Wrench className="h-5 w-5 text-[var(--taxi-amber)]" />
          Platform Operations
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
            href="/admin/pipeline-health?tab=providers"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Activity className="w-5 h-5 text-cyan-400" />
              <span className="font-medium text-white">Pipeline Health</span>
            </div>
            <p className="text-xs text-zinc-500">Provider, extraction, enrichment, dedupe, and embedding diagnostics</p>
          </Link>
          <Link
            href="/extractions"
            className="block p-4 rounded-xl border border-white/10 hover:border-emerald-400/30 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <Activity className="w-5 h-5 text-emerald-400" />
              <span className="font-medium text-white">Extraction Activity</span>
            </div>
            <p className="text-xs text-zinc-500">Backlog coverage, latest results, source evidence, and review status</p>
          </Link>
        </div>
      </section>

    </div>
  );
}
