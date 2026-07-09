"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Shield, Share2, Lock, Eye, EyeOff, Check, AlertCircle, Building2, ClipboardCheck, TrendingUp, Activity, Users, Award } from "lucide-react";
import { getOrgPrivacy, updateOrgPrivacy, OrgPrivacySettings } from "@/lib/api";

// Cache bust: 2026-07-10

const PRIVACY_OPTIONS = [
  {
    key: "share_listings",
    label: "Listings",
    description: "Contribute and access inventory listings from the shared market",
    icon: Building2,
  },
  {
    key: "share_requirements",
    label: "Requirements",
    description: "Share buyer/tenant needs with the network",
    icon: ClipboardCheck,
  },
  {
    key: "share_price_trends",
    label: "Price Trends",
    description: "Contribute anonymized price per sqft data by market",
    icon: TrendingUp,
  },
  {
    key: "share_market_activity",
    label: "Market Activity",
    description: "Share aggregated market velocity and transaction signals",
    icon: Activity,
  },
  {
    key: "share_building_intelligence",
    label: "Building Intelligence",
    description: "Contribute building-level data (inventory, amenities, specs)",
    icon: Building2,
  },
  {
    key: "share_broker_network",
    label: "Broker Network",
    description: "Allow your broker connections to be discoverable in the network",
    icon: Users,
  },
  {
    key: "share_broker_reputation",
    label: "Broker Reputation",
    description: "Share anonymized broker activity scores and responsiveness",
    icon: Award,
  },
  {
    key: "share_demand_signals",
    label: "Demand Signals",
    description: "Contribute aggregated buyer/tenant demand heatmaps",
    icon: MapPin,
  },
] as const;

import { Building2, ClipboardCheck, TrendingUp, Activity, Users, Award, MapPin } from "lucide-react";

export default function PrivacyPage() {
  const router = useRouter();
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
      const orgId = "00000000-0000-0000-0000-000000000010"; // Default org
      const data = await getOrgPrivacy(orgId);
      setPrivacy(data);
    } catch (err) {
      setError("Failed to load privacy settings");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(key: keyof OrgPrivacySettings, value: boolean) {
    if (!privacy || saving) return;

    const newSettings = { ...privacy, [key]: value };

    // If switching to shared mode, ensure at least one share option is enabled
    if (key === "privacy_mode" && value === "shared") {
      const hasShareEnabled = Object.keys(privacy).some(
        k => k.startsWith("share_") && (k === "share_listings" ? true : privacy[k as keyof OrgPrivacySettings])
      );
      if (!hasShareEnabled) {
        setError("At least one share option must be enabled for Shared Market mode");
        return;
      }
    }

    // If switching to private mode, disable all share options
    if (key === "privacy_mode" && value === "private") {
      Object.keys(newSettings).forEach(k => {
        if (k.startsWith("share_")) {
          (newSettings as any)[k] = false;
        }
      });
    }

    setSaving(true);
    setError(null);
    try {
      const orgId = "00000000-0000-0000-0000-000000000010";
      const updated = await updateOrgPrivacy(orgId, newSettings);
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
    <div className="max-w-3xl mx-auto px-4 lg:px-6 pt-12 pb-12 space-y-6">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">Privacy</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Control what data contributes to the shared market network. Personal chats, client conversations,
          direct messages, and WhatsApp messages never leave your workspace.
        </p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Privacy Mode Toggle */}
      <div className="rounded-2xl border border-white/10 bg-zinc-900 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/10">
          <h3 className="text-sm font-bold text-white">Privacy Mode</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Choose how your workspace participates in the PropAI network
          </p>
        </div>
        <div className="p-6">
          <div className="grid md:grid-cols-2 gap-4">
            {/* Private Mode */}
            <button
              onClick={() => handleToggle("privacy_mode", "private")}
              disabled={saving}
              className={`relative p-4 rounded-xl border-2 transition-all ${
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
                  <div className="text-xs text-zinc-500">Default — Nothing shared</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-zinc-500 space-y-1">
                <p>• Conversations stay in your workspace</p>
                <p>• Groups, DMs, listings, requirements — all private</p>
                <p>• Broker relationships never leave your org</p>
              </div>
            </button>

            {/* Shared Market Mode */}
            <button
              onClick={() => handleToggle("privacy_mode", "shared")}
              disabled={saving}
              className={`relative p-4 rounded-xl border-2 transition-all ${
                privacy?.privacy_mode === "shared"
                  ? "border-blue-400 bg-blue-400/5"
                  : "border-white/10 hover:border-white/20"
              }`}
            >
              {privacy?.privacy_mode === "shared" && (
                <div className="absolute -top-2 -right-2 w-5 h-5 bg-blue-400 rounded-full flex items-center justify-center">
                  <Check className="w-3 h-3 text-black" />
                </div>
              )}
              <div className="flex items-center gap-3">
                <Share2 className="w-5 h-5 text-blue-400 shrink-0" />
                <div>
                  <div className="font-semibold text-white">Shared Market</div>
                  <div className="text-xs text-zinc-500">Contribute to the network</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-zinc-500 space-y-1">
                <p>• Anonymized market intelligence shared</p>
                <p>• Better visibility, cross-network inventory</p>
                <p>• Granular controls below</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      {/* Granular Share Controls */}
      {privacy?.privacy_mode === "shared" && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900 overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10">
            <h3 className="text-sm font-bold text-white">What to Share</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Select the market intelligence categories you want to contribute.
              <br />Never shared: WhatsApp messages, media, phone numbers, client chats, DMs, personal chats.
            </p>
          </div>
          <div className="p-6 space-y-3">
            {PRIVACY_OPTIONS.map(({ key, label, description }) => (
              <div key={key} className="flex items-start justify-between gap-4 p-3 rounded-lg bg-zinc-800/50">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-white text-sm">{label}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">{description}</div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    checked={privacy[key as keyof OrgPrivacySettings] as boolean}
                    onChange={(e) => handleToggle(key as keyof OrgPrivacySettings, e.target.checked)}
                    disabled={saving}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-400 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-400"></div>
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Private Mode Explanation */}
      {privacy?.privacy_mode === "private" && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900 overflow-hidden">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-emerald-400/10 flex items-center justify-center">
                <Lock className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h3 className="font-semibold text-white">Private Mode Active</h3>
                <p className="text-xs text-zinc-500">Your workspace data never leaves your organization</p>
              </div>
            </div>
            <div className="space-y-2 text-sm text-zinc-400">
              <p><strong className="text-white">What stays private:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>All WhatsApp messages and media</li>
                <li>Direct messages and personal chats</li>
                <li>Client conversations and negotiations</li>
                <li>Phone numbers and WhatsApp IDs</li>
                <li>Broker relationships and contact details</li>
                <li>Listings, requirements, and market intelligence</li>
                <li>AI memory, notes, and internal workspace data</li>
              </ul>
              <p className="mt-4"><strong className="text-white">What you don't get:</strong></p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Cross-network inventory visibility</li>
                <li>Market demand trends from other workspaces</li>
                <li>Broker reputation scores from the network</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Shared Mode - What's Never Shared */}
      {privacy?.privacy_mode === "shared" && (
        <div className="rounded-2xl border border-white/10 bg-zinc-900 overflow-hidden">
          <div className="px-6 py-4 border-b border-white/10">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-400" />
              Never Shared (Regardless of Settings)
            </h3>
          </div>
          <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-zinc-400">
            <div className="flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
              <span>WhatsApp messages & media</span>
            </div>
            <div className="flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
              <span>Phone numbers & WhatsApp IDs</span>
            </div>
            <div className="flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
              <span>Direct messages & personal chats</span>
            </div>
            <div className="flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
              <span>Client conversations & negotiations</span>
            </div>
            <div className="flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
              <span>AI memory, notes & internal data</span>
            </div>
            <div className="flex items-center gap-2">
              <EyeOff className="w-4 h-4 text-red-400 shrink-0" />
              <span>Profile photos & presence</span>
            </div>
          </div>
        </div>
      )}

      {saved && (
        <div className="fixed bottom-4 right-4 bg-emerald-400 text-black px-4 py-2 rounded-lg text-sm font-semibold shadow-lg">
          Saved successfully
        </div>
      )}
    </div>
  );
}