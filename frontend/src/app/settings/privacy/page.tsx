"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { Shield, EyeOff, Check, Loader2, Users, MinusCircle } from "lucide-react";
import { getPrivacyReceiptStatus, getExcludedGroups, setExcludedGroups, getGroups, PrivacyReceiptStatus } from "@/lib/api";
import { useAuth } from "@/lib/AuthProvider";

interface Group {
  jid: string;
  name: string;
  participants: number;
  parsed?: {
    markets?: string[];
    segments?: string[];
  };
}

export default function PrivacyPage() {
  const { user, loading: authLoading } = useAuth();
  const [receipt, setReceipt] = useState<PrivacyReceiptStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [excludedJids, setExcludedJids] = useState<string[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    loadAll();
  }, [authLoading]);

  async function loadAll() {
    try {
      setLoading(true);
      const [receiptData, excludedData, groupsData] = await Promise.all([
        getPrivacyReceiptStatus(),
        getExcludedGroups(),
        getGroups(),
      ]);
      setReceipt(receiptData);
      setExcludedJids(excludedData || []);
      setGroups(groupsData || []);
    } catch (e) {
      console.error("Failed to load privacy data:", e);
    } finally {
      setLoading(false);
      setGroupsLoading(false);
    }
  }

  async function handleExcludeToggle(jid: string, checked: boolean) {
    const newList = checked
      ? [...excludedJids, jid]
      : excludedJids.filter((j) => j !== jid);
    setSaving(true);
    setError(null);
    try {
      await setExcludedGroups(newList);
      setExcludedJids(newList);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError("Failed to update excluded groups");
      console.error(e);
    } finally {
      setSaving(false);
    }
  }

  const sharedMarketDefault = receipt?.shared_market_default ?? true;
  const privateGroupsExcluded = receipt?.private_groups_excluded ?? 0;
  const marketGroupsDetected = receipt?.market_groups_detected ?? 0;

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 lg:px-6 pt-12 pb-12">
        <div className="p-8 text-center text-zinc-500">
          <Loader2 className="w-8 h-8 mx-auto animate-spin text-blue-400" />
          <p className="mt-2 text-sm">Loading privacy settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-6 pt-12 pb-12 space-y-6">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">Privacy</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Control which WhatsApp groups contribute to the shared market intelligence.
        </p>
        <p className="mt-2 text-xs text-zinc-600">
          Shared Market default: {sharedMarketDefault ? "on" : "off"} · DMs always private · {privateGroupsExcluded} of {marketGroupsDetected} groups opted out
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          {error}
        </div>
      )}

      {/* Groups Sharing to the Network */}
      <div className="rounded-2xl border border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Users className="w-4 h-4 text-emerald-400" />
              Groups Sharing to the Network
            </h3>
            <p className="mt-1 text-xs text-zinc-500">
              {marketGroupsDetected} real-estate groups detected · {privateGroupsExcluded} opted out
            </p>
          </div>
        </div>
        <div className="p-6">
          {groupsLoading ? (
            <div className="text-center text-zinc-500 py-8">
              <Loader2 className="w-8 h-8 mx-auto animate-spin text-blue-400" />
            </div>
          ) : groups.length === 0 ? (
            <div className="text-center text-zinc-500 py-8">
              <p>No real-estate groups detected yet.</p>
              <p className="mt-1 text-xs">Groups appear here after the first successful sync.</p>
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {groups.map((group) => {
                const excluded = excludedJids.includes(group.jid);
                return (
                  <div
                    key={group.jid}
                    className="flex items-center justify-between p-3 rounded-lg border border-white/10 hover:border-white/20 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center flex-shrink-0">
                        <Users className="w-4 h-4 text-zinc-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">
                          {group.name || "Unnamed Group"}
                        </p>
                        <p className="text-xs text-zinc-500 truncate">
                          {group.participants} members · {group.parsed?.markets?.join(", ") || "No markets tagged"}
                        </p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!excluded}
                        onChange={(e) => handleExcludeToggle(group.jid, !e.target.checked)}
                        disabled={saving}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-400"></div>
                    </label>
                  </div>
                );
              })}
            <p className="mt-4 text-xs text-zinc-500 text-center">
              Unchecked = group is opted OUT (never parsed, never shared).
            </p>
          )}
        </div>
      </div>

      {/* What's Never Parsed */}
      <div className="rounded-2xl border border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-400" />
            Never Parsed (Regardless of Settings)
          </h3>
        </div>
        <div className="p-6 space-y-3 text-sm text-zinc-400">
          <div className="flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
            <span>Direct messages and personal chats</span>
          </div>
          <div className="flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
            <span>Client conversations and negotiations</span>
          </div>
          <div className="flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
            <span>Friends and family groups</span>
          </div>
          <div className="flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
            <span>Groups you have opted out of parsing</span>
          </div>
          <div className="mt-4 p-3 rounded-lg bg-zinc-800 text-xs text-zinc-500">
            PropAI only parses real-estate WhatsApp groups. Non-real-estate groups, personal conversations, and opted-out groups are never extracted or stored in the knowledge base.
          </div>
        </div>
      </div>

      {saved && (
        <div className="fixed bottom-4 right-4 bg-emerald-400 text-black px-4 py-2 rounded-lg text-sm font-semibold shadow-lg">
          Saved successfully
        </div>
      )}
    </div>
  );
}