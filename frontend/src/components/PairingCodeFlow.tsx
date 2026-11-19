"use client";

import { Check, Hash, RefreshCw, X } from "lucide-react";

type Props = {
  number: string; editable: boolean; code: string | null; pending: boolean; connected: boolean;
  error: string | null; warning?: string | null; secondsRemaining: number; copied: boolean; busy: boolean;
  onNumberChange: (value: string) => void; onStart: () => void; onQR: () => void;
  onClose: () => void; onCopy: () => void; onCopyError: () => void; retryAllowed: boolean;
};

/** Presentation only: parent owns authenticated pairing status and all effects. */
export function PairingCodeFlow(p: Props) {
  const title = p.connected ? "WhatsApp connected" : p.pending ? "Getting your code" : p.code ? "Link in WhatsApp" : p.error ? "We could not prepare your code" : "Connect WhatsApp";
  const primary = "min-h-12 w-full rounded-xl bg-emerald-400 px-4 py-3 text-base font-semibold text-emerald-950 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50";
  return <section role="dialog" aria-modal="true" aria-label={title} className="max-h-[90dvh] overflow-y-auto rounded-2xl bg-[#0d161e] text-zinc-100">
    <header className="flex items-start gap-3 border-b border-white/10 px-6 py-5">
      {p.connected ? <Check className="mt-1 h-6 w-6 text-emerald-400" /> : p.pending ? <RefreshCw className="mt-1 h-6 w-6 animate-spin text-emerald-400" /> : <Hash className="mt-1 h-6 w-6 text-emerald-400" />}
      <div className="min-w-0 flex-1"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-zinc-400">{p.connected ? "Your WhatsApp link is active." : p.pending ? "No need to reset or tap again." : p.code ? "Your code is ready." : p.error ? "No code is active." : "Your number. One linking code."}</p></div>
      <button type="button" onClick={p.onClose} aria-label="Close pairing" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-white/5"><X className="h-5 w-5" /></button>
    </header>
    <div className="space-y-5 px-6 py-6">
      {p.warning && <div role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm leading-6 text-amber-100">{p.warning}</div>}
      {p.connected ? <>
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-4"><p className="font-semibold text-emerald-300">Connected</p><p className="mt-2 text-sm leading-6 text-zinc-400">New messages can sync to your workspace. Check message activity separately to confirm capture.</p></div>
        <button type="button" onClick={p.onClose} className={primary}>Done</button>
      </> : p.pending ? <div role="status" aria-live="polite" className="rounded-xl border border-white/10 bg-white/[0.03] p-5 text-center"><p className="font-semibold">Preparing a secure connection…</p><p className="mt-3 text-sm leading-6 text-zinc-400">PropAI is checking the session and preparing your code. Please keep this page open.</p></div> : p.code ? <>
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 text-center"><p className="text-xs uppercase tracking-widest text-zinc-400">Your linking code</p><div className="my-5 break-all font-mono text-3xl font-semibold tracking-widest text-emerald-300">{p.code}</div><button type="button" onClick={p.onCopy} className={primary}>{p.copied ? "Code copied" : "Copy code"}</button><p aria-live="polite" className="mt-3 text-xs text-zinc-400">Session window remaining: {Math.floor(Math.max(0,p.secondsRemaining)/60)}:{String(Math.max(0,p.secondsRemaining)%60).padStart(2,"0")}</p></div>
        <div><h3 className="font-semibold">In WhatsApp on your phone</h3><ol className="mt-3 list-decimal space-y-3 pl-5 text-sm leading-6 text-zinc-300"><li>Open Settings → Linked devices.</li><li>Tap Link a device → Link with phone number instead.</li><li>Enter this code.</li></ol></div><p role="status" className="text-sm leading-6 text-zinc-400">Waiting for WhatsApp confirmation. Keep this page open, we will confirm when the link is active.</p>
      </> : <>
        {p.error && <div role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-4"><p className="text-sm leading-6 text-amber-100">{p.error}</p><p className="mt-3 text-sm leading-6 text-zinc-300">Do not reset WhatsApp again. If this continues, share this error with PropAI support. Never share a linking code.</p></div>}
        <label className="block text-sm font-semibold">WhatsApp number<input type="tel" autoComplete="tel" inputMode="tel" value={p.number} readOnly={!p.editable} onChange={e=>p.onNumberChange(e.target.value.replace(/[^0-9]/g,""))} onKeyDown={e=>{if(e.key==="Enter"&&!p.busy&&p.number.length>=10&&(!p.error||p.retryAllowed))p.onStart();}} placeholder="Country code + WhatsApp number" className="mt-3 min-h-12 w-full rounded-xl border border-white/20 bg-white/[0.03] px-4 py-3 text-base font-normal outline-none focus:border-emerald-400" /></label>
        <p className="text-sm leading-6 text-zinc-400">{p.editable ? "Include your country code. For India, start with 91." : "To connect a different number, add it as a new phone first."}</p>
        {(!p.error||p.retryAllowed) && <button type="button" onClick={p.onStart} disabled={p.busy||p.number.length<10} className={primary}>{p.retryAllowed ? "Get one new code" : "Get linking code"}</button>}
        {p.error ? <button type="button" onClick={p.onCopyError} className={primary}>Copy error for support</button> : <><p className="text-xs leading-5 text-zinc-400">Confirm the link in WhatsApp. This step does not send a message.</p><button type="button" onClick={p.onQR} disabled={p.busy} className="min-h-11 w-full text-sm text-emerald-300 underline underline-offset-4 disabled:opacity-50">Use QR code instead</button></>}
      </>}
    </div>
  </section>;
}
