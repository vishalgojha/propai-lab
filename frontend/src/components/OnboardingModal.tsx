"use client";

import { useState } from "react";
import { X, Smartphone } from "lucide-react";
import { saveProfile } from "@/lib/api";

interface Props {
  phone: string;
  defaultFirstName?: string;
  onClose: () => void;
  onComplete: (profile: { first_name: string; last_name: string; email: string; city: string }) => void;
}

export function OnboardingModal({ phone, defaultFirstName, onClose, onComplete }: Props) {
  const [firstName, setFirstName] = useState(defaultFirstName || "");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [city, setCity] = useState("");
  const [customCity, setCustomCity] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const finalCity = city === "__other__" ? customCity.trim() : city;
      const data = { first_name: firstName.trim(), last_name: lastName.trim(), email: email.trim(), city: finalCity };
      await saveProfile(phone, data);
      localStorage.setItem("propai_profile", JSON.stringify({ phone, ...data }));
      onComplete(data);
    } catch (err: any) {
      setError(err.message || "Failed to save profile");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[800] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg font-bold text-white">Welcome to PropAI</h2>
          <button onClick={onClose} className="p-1 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
          {/* Phone (read-only) */}
          <div>
            <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">WhatsApp Number</label>
            <div className="mt-1 flex items-center gap-2 rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-300">
              <Smartphone className="w-4 h-4 text-zinc-500 shrink-0" />
              <span className="font-mono">{phone}</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="fn" className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">First Name *</label>
              <input id="fn" value={firstName} onChange={e => setFirstName(e.target.value)} required
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                placeholder="Your name" />
            </div>
            <div>
              <label htmlFor="ln" className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Last Name</label>
              <input id="ln" value={lastName} onChange={e => setLastName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                placeholder="Optional" />
            </div>
          </div>

          <div>
            <label htmlFor="em" className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Email</label>
            <input id="em" type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
              placeholder="your@email.com" />
          </div>

          <div>
            <label htmlFor="ct" className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">City</label>
            <select id="ct" value={city} onChange={e => { setCity(e.target.value); if (e.target.value !== "__other__") setCustomCity(""); }}
              className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white outline-none focus:border-emerald-500/50 transition-colors appearance-none">
              <option value="" disabled>Select your city</option>
              <option value="Mumbai">Mumbai</option>
              <option value="Delhi / NCR">Delhi / NCR</option>
              <option value="Bangalore">Bangalore</option>
              <option value="Pune">Pune</option>
              <option value="Hyderabad">Hyderabad</option>
              <option value="Chennai">Chennai</option>
              <option value="Ahmedabad">Ahmedabad</option>
              <option value="Kolkata">Kolkata</option>
              <option value="Surat">Surat</option>
              <option value="Jaipur">Jaipur</option>
              <option value="Lucknow">Lucknow</option>
              <option value="Chandigarh">Chandigarh</option>
              <option value="Kochi">Kochi</option>
              <option value="Indore">Indore</option>
              <option value="Nagpur">Nagpur</option>
              <option value="Goa">Goa</option>
              <option value="__other__">Other</option>
            </select>
            {city === "__other__" && (
              <input value={customCity} onChange={e => setCustomCity(e.target.value)}
                className="mt-2 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                placeholder="Type your city" autoFocus />
            )}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <button type="submit" disabled={saving || !firstName.trim()}
            className="w-full rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-black min-h-[44px] disabled:opacity-50 transition-opacity">
            {saving ? "Saving..." : "Get Started"}
          </button>
        </form>
      </div>
    </div>
  );
}
