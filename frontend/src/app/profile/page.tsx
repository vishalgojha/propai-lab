"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Smartphone, Save, X } from "lucide-react";
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

  useEffect(() => {
    const stored = localStorage.getItem("propai_profile");
    if (stored) {
      try {
        const p = JSON.parse(stored);
        setProfile(p);
        setFirstName(p.first_name || "");
        setLastName(p.last_name || "");
        setEmail(p.email || "");
        const c = p.city || "";
        if (CITIES.includes(c)) { setCity(c); } else if (c) { setCity("__other__"); setCustomCity(c); }
      } catch {}
    }
    setLoading(false);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !profile?.phone) return;
    setSaving(true);
    setSaved(false);
    try {
      const finalCity = city === "__other__" ? customCity.trim() : city;
      const data = { first_name: firstName.trim(), last_name: lastName.trim(), email: email.trim(), city: finalCity };
      await saveProfile(profile.phone, data);
      localStorage.setItem("propai_profile", JSON.stringify({ ...profile, ...data }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { alert("Failed to save profile"); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="p-8 text-zinc-500">Loading...</div>;

  return (
    <div className="max-w-2xl mx-auto px-4 lg:px-6 pt-12 pb-12">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">Profile</h2>
        <p className="mt-1 text-sm text-zinc-500">Your personal details and account information</p>
      </div>

      <form onSubmit={handleSubmit} className="rounded-2xl border border-white/10 bg-zinc-900 overflow-hidden">
        {/* Phone (read-only) */}
        <div className="px-6 pt-6 pb-4 border-b border-white/5">
          <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">WhatsApp Number</label>
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-300">
            <Smartphone className="w-4 h-4 text-zinc-500 shrink-0" />
            <span className="font-mono">{profile?.phone || "—"}</span>
          </div>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">First Name *</label>
              <input value={firstName} onChange={e => setFirstName(e.target.value)} required
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors" />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Last Name</label>
              <input value={lastName} onChange={e => setLastName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors" />
            </div>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors" />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">City</label>
            <select value={city} onChange={e => { setCity(e.target.value); if (e.target.value !== "__other__") setCustomCity(""); }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500/50 transition-colors appearance-none">
              <option value="">Select your city</option>
              {CITIES.map(c => <option key={c} value={c}>{c}</option>)}
              <option value="__other__">Other</option>
            </select>
            {city === "__other__" && (
              <input value={customCity} onChange={e => setCustomCity(e.target.value)} autoFocus
                className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                placeholder="Type your city" />
            )}
          </div>
        </div>

        <div className="px-6 py-4 bg-[#161b22] border-t border-white/10 flex items-center justify-between">
          <div>
            {saved && <span className="text-xs text-emerald-400">Saved successfully</span>}
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={saving || !firstName.trim()}
              className="flex items-center gap-2 px-5 py-2.5 bg-emerald-400 text-black rounded-lg text-sm font-bold min-h-[44px] disabled:opacity-50 transition-opacity">
              <Save className="w-4 h-4" />
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </form>

      {/* Nav card */}
      <div className="mt-6 rounded-2xl border border-white/10 bg-zinc-900 overflow-hidden">
        <div className="px-6 py-4 border-b border-white/5">
          <h3 className="text-sm font-bold text-white">Account</h3>
        </div>
        <div className="divide-y divide-white/5">
          <button onClick={() => router.push("/profile/team")}
            className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-white/5 transition-colors">
            <div>
              <div className="text-sm font-medium text-white">Team Management</div>
              <div className="text-xs text-zinc-500">Manage team members and custom roles</div>
            </div>
            <span className="text-zinc-500 text-lg">&rarr;</span>
          </button>
        </div>
      </div>
    </div>
  );
}
