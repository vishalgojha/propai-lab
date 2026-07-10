"use client";

import { useState } from "react";
import { X, Smartphone, Check, AlertCircle, Building2 } from "lucide-react";
import { saveProfile } from "@/lib/api";

interface Props {
  phone: string;
  defaultFirstName?: string;
  onClose: () => void;
  onComplete: (profile: { first_name: string; last_name: string; email: string; city: string; phone: string; workspace_name?: string }) => void;
}

export function OnboardingModal({ phone, defaultFirstName, onClose, onComplete }: Props) {
  const [step, setStep] = useState<"confirm_phone" | "details">("confirm_phone");
  const [confirmedPhone, setConfirmedPhone] = useState(phone);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePhoneConfirm = () => {
    if (!confirmedPhone.trim()) return;
    setStep("details");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;
    if (!email.trim()) {
      setError("Email is required for account recovery");
      return;
    }
    if (!workspaceName.trim()) {
      setError("Workspace name is required");
      return;
    }
    setSaving(true);
    setError(null);
    const data = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      email: email.trim(),
      city: "",
      phone: confirmedPhone.trim(),
      workspace_name: workspaceName.trim(),
    };
    // Persist locally first
    localStorage.setItem("propai_profile", JSON.stringify({ phone: confirmedPhone, ...data }));
    try {
      await saveProfile(confirmedPhone, data);
    } catch {
      // Non-fatal: profile saved locally
    }
    setSaving(false);
    onComplete(data);
  };

  return (
    <div className="fixed inset-0 z-[800] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 shadow-2xl">
        <div className="flex items-center justify-between px-6 pt-6 pb-4">
          <h2 className="text-lg font-bold text-white">
            {step === "confirm_phone" ? "Confirm Your Number" : "Create Your Workspace"}
          </h2>
          <button onClick={onClose} className="p-1 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 pb-6 space-y-4">
          {step === "confirm_phone" && (
            <>
              <div className="text-center py-4">
                <Smartphone className="w-16 h-16 mx-auto text-emerald-400" />
                <h3 className="mt-4 text-lg font-semibold text-white">We detected your WhatsApp number</h3>
                <p className="mt-1 text-sm text-zinc-500">This will be your primary identity on PropAI</p>
              </div>

              <div className="rounded-lg border border-white/10 bg-zinc-800/50 p-4 space-y-3">
                <label className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">WhatsApp Number</label>
                <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5">
                  <Smartphone className="w-5 h-5 text-zinc-500 shrink-0" />
                  <input
                    type="tel"
                    value={confirmedPhone}
                    onChange={e => setConfirmedPhone(e.target.value)}
                    className="flex-1 bg-transparent text-sm text-white placeholder-zinc-500 outline-none"
                    placeholder="+91 98765 43210"
                  />
                </div>
                <p className="text-xs text-zinc-500">This number will be your primary login identity. You can add more numbers later in Settings.</p>
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-3">
                <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="text-sm text-emerald-300">Yes, this is my work number — continue</span>
              </div>

              <button
                type="button"
                onClick={handlePhoneConfirm}
                className="w-full rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-black transition-opacity"
              >
                Confirm & Continue
              </button>
            </>
          )}

          {step === "details" && (
            <>
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
                <label htmlFor="em" className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Email *</label>
                <input id="em" type="email" value={email} onChange={e => setEmail(e.target.value)} required
                  className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-800/50 px-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                  placeholder="your@email.com (for recovery)" />
                <p className="mt-1 text-xs text-zinc-500">Used only for account recovery & notifications. Never shared.</p>
              </div>

              <div>
                <label htmlFor="ws" className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Workspace Name *</label>
                <div className="relative mt-1">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-zinc-500" />
                  <input id="ws" value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} required
                    className="w-full rounded-lg border border-white/10 bg-zinc-800/50 pl-10 pr-3 py-2.5 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500/50 transition-colors"
                    placeholder="e.g., Acme Realty" />
                </div>
                <p className="mt-1 text-xs text-zinc-500">Your team&apos;s shared workspace. You can invite teammates later.</p>
              </div>

              {error && <p className="text-xs text-red-400">{error}</p>}

              <button type="submit" disabled={saving || !firstName.trim() || !email.trim() || !workspaceName.trim()}
                className="w-full rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-bold text-black min-h-[44px] disabled:opacity-50 transition-opacity">
                {saving ? "Creating Workspace..." : "Create Workspace"}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}