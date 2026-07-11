"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { Shield, Share2, Lock, EyeOff, Check, AlertCircle, Building2, Users, MessageSquare, UserCheck } from "lucide-react";
import { getOrgPrivacy, updateOrgPrivacy, OrgPrivacySettings } from "@/lib/api";

export default function PrivacyPage() {
  const [privacy, setPrivacy] = useState<OrgPrivacySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadPrivacy();
  }, []);

  async function loadPrivacy() {
    try {
      const orgId = "00000000-0000-0000-0000-000000000010";
      const data = await getOrgPrivacy(orgId);
      setPrivacy(data);
    } catch (err) {
      setError("Failed to load privacy settings");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(value: "private" | "shared_market") {
    if (!privacy || saving) return;
    setSaving(true);
    setError(null);
    try {
      const orgId = "00000000-0000-0000-0000-000000000010";
      const updated = await updateOrgPrivacy(orgId, { privacy_mode: value });
      setPrivacy(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError("Failed to update privacy settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-8 text-zinc-500">Loading...</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 lg:px-6 pt-12 pb-12 space-y-6">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">Privacy</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Control how your data participates in the PropAI network.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Mode Selection */}
      <div className="rounded-2xl border border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10">
          <h3 className="text-sm font-bold text-white">Network Participation</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Choose how your workspace interacts with the broker network
          </p>
        </div>
        <div className="p-6">
          <div className="grid md:grid-cols-2 gap-4">
            {/* Broker Network (Default) */}
            <button
              onClick={() => handleToggle("shared_market")}
              disabled={saving}
              className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                privacy?.privacy_mode === "shared_market"
                  ? "border-blue-400 bg-blue-400/5"
                  : "border-white/10 hover:border-white/20"
              }`}
            >
              {privacy?.privacy_mode === "shared_market" && (
                <div className="absolute -top-2 -right-2 w-5 h-5 bg-blue-400 rounded-full flex items-center justify-center">
                  <Check className="w-3 h-3 text-black" />
                </div>
              )}
              <div className="flex items-center gap-3">
                <Share2 className="w-5 h-5 text-blue-400 shrink-0" />
                <div>
                  <div className="font-semibold text-white">Broker Network</div>
                  <div className="text-xs text-zinc-500">Default — Contribute to the shared market</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-zinc-500 space-y-1">
                <p>• Listings, requirements, and market intelligence are shared</p>
                <p>• Cross-network inventory visibility</p>
                <p>• Broker reputation and demand signals</p>
              </div>
            </button>

            {/* Private */}
            <button
              onClick={() => handleToggle("private")}
              disabled={saving}
              className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                privacy?.privacy_mode === "private"
                  ? "border-emerald-400 bg-emerald-400/5"
                  : "border-white/10 hover:border-white/20"
              }`}
            >
              {privacy?.privacy_mode === "private" && (
                <div className="absolute -top-2 -right-2 w-5 h-5 bg-emerald-400 rounded-full flex items-center justify-center">
                  <Check className="w-3 h-3 text-black" />
                </div>
              )}
              <div className="flex items-center gap-3">
                <Lock className="w-5 h-5 text-emerald-400 shrink-0" />
                <div>
                  <div className="font-semibold text-white">Private</div>
                  <div className="text-xs text-zinc-500">Premium — Nothing leaves your workspace</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-zinc-500 space-y-1">
                <p>• All data stays within your organization</p>
                <p>• No listings, requirements, or intelligence shared</p>
                <p>• No cross-network visibility</p>
              </div>
            </button>
          </div>
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
