"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Smartphone, Save, Users, CreditCard, Key, Settings, Mail, MapPin, User } from "lucide-react";
import { getProfile, saveProfile, getCurrentOrg, getPhones, isLiveWhatsAppConnection, updateOrganization, type Phone } from "@/lib/api";
import { useAuth } from "@/lib/AuthProvider";

const CITIES = [
  "Mumbai", "Delhi / NCR", "Bangalore", "Pune", "Hyderabad",
  "Chennai", "Ahmedabad", "Kolkata", "Surat", "Jaipur",
  "Lucknow", "Chandigarh", "Kochi", "Indore", "Nagpur", "Goa",
];

export default function ProfilePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [hasStoredProfile, setHasStoredProfile] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [cityOpen, setCityOpen] = useState(false);
  const [customCity, setCustomCity] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [org, setOrg] = useState<{ id: string; name?: string; slug?: string } | null>(null);
  const [phones, setPhones] = useState<Phone[]>([]);
  const next = searchParams.get("next") || "";

  // Load profile from API on mount
  useEffect(() => {
    let mounted = true;
    const fullName = String(user?.user_metadata?.full_name || "").trim();
    const [defaultFirstName = "", ...defaultLastNameParts] = fullName.split(/\s+/);
    const stored = localStorage.getItem("propai_profile");
    let localProfile: any = null;
    if (stored) {
      try { localProfile = JSON.parse(stored); } catch {}
    }
    const baseProfile = {
      auth_user_id: user?.id || "",
      phone: localProfile?.auth_user_id === user?.id ? localProfile?.phone || user?.phone || "" : user?.phone || "",
      first_name: localProfile?.auth_user_id === user?.id ? localProfile?.first_name || defaultFirstName || "" : defaultFirstName || "",
      last_name: localProfile?.auth_user_id === user?.id ? localProfile?.last_name || defaultLastNameParts.join(" ") : defaultLastNameParts.join(" "),
      email: localProfile?.auth_user_id === user?.id ? localProfile?.email || user?.email || "" : user?.email || "",
      city: localProfile?.auth_user_id === user?.id ? localProfile?.city || "" : "",
    };

    const applyProfile = (data: any) => {
      setProfile(data);
      setFirstName(data.first_name || "");
      setLastName(data.last_name || "");
      setEmail(data.email || "");
      const c = data.city || "";
      if (CITIES.includes(c)) {
        setCity(c);
        setCustomCity("");
      } else if (c) {
        setCity("__other__");
        setCustomCity(c);
      } else {
        setCity("");
        setCustomCity("");
      }
    };

    applyProfile(baseProfile);
    setHasStoredProfile(Boolean(localProfile?.auth_user_id === user?.id && localProfile?.first_name));

    getProfile(baseProfile.phone, user?.id).then((data: any) => {
      if (!mounted) return;
      if (data && data.first_name) {
        applyProfile({ ...baseProfile, ...data });
        setHasStoredProfile(true);
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { mounted = false; };
  }, [user]);

  useEffect(() => {
    getCurrentOrg().then((data) => {
      setOrg(data);
      setWorkspaceName(data?.name || "");
    }).catch(() => {});
    getPhones(false, 12000).then((data) => setPhones(data.phones || [])).catch(() => {});
  }, []);

  const markDirty = () => setDirty(true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !email.trim()) return;
    setSaving(true);
    setSaved(false);
    const finalCity = city === "__other__" ? customCity.trim() : (city || profile?.city || "");
    const finalWorkspaceName = workspaceName.trim() || org?.name || "";
    const data = { first_name: firstName.trim(), last_name: lastName.trim(), email: email.trim(), city: finalCity };
    const localProfile = { auth_user_id: user?.id || "", phone: profile?.phone || "", ...data };
    localStorage.setItem("propai_profile", JSON.stringify(localProfile));
    window.dispatchEvent(new Event("propai_profile_updated"));
    try {
      if (profile?.phone || user?.id) {
        try { await saveProfile(profile?.phone || "", data); } catch (err) {
          console.error("[profile] server save failed:", err);
        }
      }
      if (org?.id && finalWorkspaceName && finalWorkspaceName !== org.name) {
        try { await updateOrganization(org.id, { name: finalWorkspaceName }); } catch (err) {
          console.error("[profile] workspace save failed:", err);
        }
        setOrg((prev) => prev ? { ...prev, name: finalWorkspaceName } : prev);
      }
      setProfile(localProfile);
      setHasStoredProfile(true);
      setSaved(true);
      setDirty(false);
      if (next && next !== "/profile") {
        router.push(next);
        return;
      }
      setTimeout(() => setSaved(false), 2000);
    } catch { alert("Failed to save profile"); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="h-[calc(100vh-4rem)] flex items-center justify-center text-zinc-500">Loading...</div>;

  return (
    <div className="h-[calc(100vh-4rem)] overflow-y-auto bg-black">
      {/* Sticky Header */}
      <header className="sticky top-0 z-20 bg-black/95 backdrop-blur border-b border-white/10">
        <div className="max-w-[1400px] mx-auto px-4 lg:px-6 py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-white">Profile</h1>
            <p className="text-sm text-zinc-500">Personal details and account settings</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {saved && <span className="text-xs text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded">Saved</span>}
            {dirty && !saving && (
              <span className="text-xs text-amber-400 bg-amber-400/10 px-2 py-1 rounded">Unsaved changes</span>
            )}
            <button
              type="submit"
              form="profile-form"
              disabled={saving || !firstName.trim() || !email.trim() || (!dirty && hasStoredProfile && !next)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-400 text-black rounded-lg text-sm font-bold min-h-[40px] disabled:opacity-50 transition-opacity shrink-0"
            >
              <Save className="w-4 h-4" />
              {saving ? "Saving..." : next ? "Save & Continue" : "Save Changes"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 lg:px-6 pb-8">
        <form id="profile-form" onSubmit={handleSubmit} className="grid lg:grid-cols-[1fr_380px] gap-6">
          {/* Left Column - Personal Details */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-white/10 p-6">
              <h2 className="flex items-center gap-2 text-sm font-bold text-white mb-5">
                <User className="w-4 h-4 text-emerald-400" />
                Personal Details
              </h2>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">First Name *</label>
                  <input
                    value={firstName}
                    onChange={(e) => { setFirstName(e.target.value); markDirty(); }}
                    required
                    className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Last Name</label>
                  <input
                    value={lastName}
                    onChange={(e) => { setLastName(e.target.value); markDirty(); }}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Email</label>
                <div className="mt-1 flex items-center gap-2">
                  <Mail className="w-4 h-4 text-zinc-500 shrink-0" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); markDirty(); }}
                    required
                    className="flex-1 rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                    placeholder="your@email.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">City</label>
                  <div className="relative mt-1">
                    <button
                      type="button"
                      onClick={() => setCityOpen((open) => !open)}
                      className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-left text-sm text-white outline-none transition-colors hover:bg-zinc-800 focus:border-emerald-500/50"
                    >
                      <span className={city ? "text-white" : "text-zinc-500"}>
                        {city === "__other__" ? customCity || "Other" : city || "Select your city"}
                      </span>
                      <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${cityOpen ? "rotate-180" : ""}`} />
                    </button>
                    {cityOpen && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-zinc-950 py-1 shadow-2xl">
                        <button
                          type="button"
                          onClick={() => { setCity(""); setCustomCity(""); setCityOpen(false); markDirty(); }}
                          className="block w-full px-3 py-2 text-left text-sm text-zinc-500 transition-colors hover:bg-white/5 hover:text-white"
                        >
                          Select your city
                        </button>
                        {CITIES.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => { setCity(c); setCustomCity(""); setCityOpen(false); markDirty(); }}
                            className={`block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-emerald-400/10 hover:text-emerald-300 ${city === c ? "bg-emerald-400/10 text-emerald-300" : "text-zinc-200"}`}
                          >
                            {c}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => { setCity("__other__"); setCityOpen(false); markDirty(); }}
                          className={`block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-emerald-400/10 hover:text-emerald-300 ${city === "__other__" ? "bg-emerald-400/10 text-emerald-300" : "text-zinc-200"}`}
                        >
                          Other
                        </button>
                      </div>
                    )}
                  </div>
                  {city === "__other__" && (
                    <input
                      value={customCity}
                      onChange={(e) => { setCustomCity(e.target.value); markDirty(); }}
                      autoFocus
                      className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                      placeholder="Type your city"
                    />
                  )}
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">WhatsApp Number</label>
                  <div className="mt-1 flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-300">
                    <Smartphone className="w-4 h-4 text-zinc-500 shrink-0" />
                    <span className="font-mono text-white">
                      {(() => {
                        const live = phones.find((p) => isLiveWhatsAppConnection(p));
                        const candidate = live?.phone_number_live || live?.phone_number || profile?.phone || "";
                        return candidate || "Not linked yet";
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Workspace Info (read-only) */}
            <section className="rounded-2xl border border-white/10 p-6">
              <h2 className="flex items-center gap-2 text-sm font-bold text-white mb-5">
                <Settings className="w-4 h-4 text-emerald-400" />
                Agency / Workspace
              </h2>
              <div className="mb-4">
                <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Agency / Workspace Name</label>
                <input
                  value={workspaceName}
                  onChange={(e) => { setWorkspaceName(e.target.value); markDirty(); }}
                  className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                  placeholder="e.g. Ananta Realty"
                />
                <p className="mt-1 text-[11px] text-zinc-500">This is the workspace name shown across the app.</p>
              </div>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Role</dt>
                  <dd className="text-white font-medium">Owner</dd>
                </div>
                {org && (
                  <div className="flex justify-between items-start gap-4">
                    <dt className="text-zinc-500 shrink-0">Workspace ID</dt>
                    <dd className="text-white font-mono text-[11px] text-right break-all">{org.id}</dd>
                  </div>
                )}
                {org?.name && (
                  <div className="flex justify-between">
                    <dt className="text-zinc-500">Workspace</dt>
                    <dd className="text-white font-medium">{org.name}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Timezone</dt>
                  <dd className="text-white font-medium">Asia/Kolkata (IST)</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Language</dt>
                  <dd className="text-white font-medium">English</dd>
                </div>
              </dl>
            </section>
          </div>

          {/* Right Column - Account Actions */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-white/10 p-6 h-fit sticky top-24">
              <h2 className="flex items-center gap-2 text-sm font-bold text-white mb-5">
                <Key className="w-4 h-4 text-emerald-400" />
                Account
              </h2>
              <nav className="space-y-2">
                <button
                  type="button"
                  onClick={() => router.push("/profile/team")}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-white/5 transition-colors group"
                >
                  <div className="w-8 h-8 flex items-center justify-center">
                    <Users className="w-4 h-4 text-zinc-400 group-hover:text-emerald-400 transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">Team Management</div>
                    <div className="text-xs text-zinc-500">Members, roles, permissions</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => router.push("/profile/billing")}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-white/5 transition-colors group"
                >
                  <div className="w-8 h-8 flex items-center justify-center">
                    <CreditCard className="w-4 h-4 text-zinc-400 group-hover:text-emerald-400 transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">Billing & Plan</div>
                    <div className="text-xs text-zinc-500">Subscription, usage, invoices</div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => router.push("/waba")}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-white/5 transition-colors group"
                >
                  <div className="w-8 h-8 flex items-center justify-center">
                    <Key className="w-4 h-4 text-zinc-400 group-hover:text-emerald-400 transition-colors" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white">API Keys</div>
                    <div className="text-xs text-zinc-500">WhatsApp Business API, webhooks</div>
                  </div>
                </button>
              </nav>
            </section>

            {/* Quick Stats */}
            <section className="rounded-2xl border border-white/10 p-6">
              <h2 className="text-sm font-bold text-white mb-4">Quick Stats</h2>
              <dl className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <dt className="text-zinc-500">Messages</dt>
                  <dd className="text-white font-bold">—</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Listings</dt>
                  <dd className="text-white font-bold">—</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Requirements</dt>
                  <dd className="text-white font-bold">—</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Brokers</dt>
                  <dd className="text-white font-bold">—</dd>
                </div>
              </dl>
            </section>
          </div>
        </form>
      </main>
    </div>
  );
}
