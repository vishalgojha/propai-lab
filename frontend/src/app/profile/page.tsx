"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Smartphone, Save, Users, CreditCard, Key, Settings, Mail, MapPin, User } from "lucide-react";
import { getProfile, saveProfile } from "@/lib/api";

const CITIES = [
  "Mumbai", "Delhi / NCR", "Bangalore", "Pune", "Hyderabad",
  "Chennai", "Ahmedabad", "Kolkata", "Surat", "Jaipur",
  "Lucknow", "Chandigarh", "Kochi", "Indore", "Nagpur", "Goa",
];

export default function ProfilePage() {
  const router = useRouter();
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [customCity, setCustomCity] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Load profile from API on mount
  useEffect(() => {
    let mounted = true;
    getProfile().then((data: any) => {
      if (!mounted) return;
      if (data && data.first_name) {
        setProfile(data);
        setFirstName(data.first_name || "");
        setLastName(data.last_name || "");
        setEmail(data.email || "");
        const c = data.city || "";
        if (CITIES.includes(c)) { setCity(c); } else if (c) { setCity("__other__"); setCustomCity(c); }
      }
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { mounted = false; };
  }, []);

  const markDirty = () => setDirty(true);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !profile?.phone) return;
    setSaving(true);
    setSaved(false);
    try {
      const finalCity = city === "__other__" ? customCity.trim() : city;
      const data = { first_name: firstName.trim(), last_name: lastName.trim(), email: email.trim(), city: finalCity };
      await saveProfile(profile.phone, data);
      setProfile({ ...profile, ...data });
      setSaved(true);
      setDirty(false);
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
              disabled={saving || !firstName.trim() || !dirty}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-400 text-black rounded-lg text-sm font-bold min-h-[40px] disabled:opacity-50 transition-opacity shrink-0"
            >
              <Save className="w-4 h-4" />
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 lg:px-6 pb-8">
        <form id="profile-form" onSubmit={handleSubmit} className="grid lg:grid-cols-[1fr_380px] gap-6">
          {/* Left Column - Personal Details */}
          <div className="space-y-6">
            <section className="rounded-2xl border border-white/10 bg-zinc-950/50 p-6">
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
                    className="flex-1 rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                    placeholder="your@email.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">City</label>
                  <select
                    value={city}
                    onChange={(e) => { setCity(e.target.value); if (e.target.value !== "__other__") setCustomCity(""); markDirty(); }}
                    className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500/50 transition-colors appearance-none"
                  >
                    <option value="">Select your city</option>
                    {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
                    <option value="__other__">Other</option>
                  </select>
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
                    <span className="font-mono text-white">{profile?.phone || "—"}</span>
                  </div>
                </div>
              </div>
            </section>

            {/* Workspace Info (read-only) */}
            <section className="rounded-2xl border border-white/10 bg-zinc-950/50 p-6">
              <h2 className="flex items-center gap-2 text-sm font-bold text-white mb-5">
                <Settings className="w-4 h-4 text-emerald-400" />
                Workspace
              </h2>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-zinc-500">Role</dt>
                  <dd className="text-white font-medium">Owner</dd>
                </div>
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
            <section className="rounded-2xl border border-white/10 bg-zinc-950/50 p-6 h-fit sticky top-24">
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
                  <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center group-hover:bg-emerald-400/20 transition-colors">
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
                  <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center group-hover:bg-emerald-400/20 transition-colors">
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
                  <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items_center justify-center group-hover:bg-emerald-400/20 transition-colors">
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
            <section className="rounded-2xl border border-white/10 bg-zinc-950/50 p-6">
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