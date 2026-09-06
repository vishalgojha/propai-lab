"use client";

import { useState } from "react";
import { Flag } from "lucide-react";

const REASONS = [
  ["unavailable", "No longer available"],
  ["incorrect_details", "Incorrect details"],
  ["duplicate", "Duplicate listing"],
  ["inappropriate", "Inappropriate content"],
  ["other", "Other"],
] as const;

export default function ReportListingButton({ listingId, cardType }: { listingId: number; cardType: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("unavailable");
  const [details, setDetails] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function submit() {
    setState("sending");
    const response = await fetch("/api/report-listing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ listing_id: listingId, card_type: cardType, reason, details }),
    }).catch(() => null);
    setState(response?.ok ? "sent" : "error");
  }

  if (state === "sent") return <p className="mt-3 text-xs text-green-300" role="status">Thanks — we sent this listing for review.</p>;
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen((value) => !value)} className="inline-flex items-center gap-1.5 text-xs text-zinc-500 transition-colors hover:text-amber-300">
        <Flag className="h-3.5 w-3.5" aria-hidden="true" /> Report listing
      </button>
      {open && (
        <div className="mt-3 rounded-xl border border-white/10 bg-zinc-950/80 p-3">
          <label className="block text-xs text-zinc-400" htmlFor={`report-reason-${listingId}`}>What looks wrong?</label>
          <select id={`report-reason-${listingId}`} value={reason} onChange={(event) => setReason(event.target.value)} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-zinc-200">
            {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <textarea value={details} onChange={(event) => setDetails(event.target.value)} maxLength={1000} placeholder="Optional details" className="mt-2 min-h-16 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 py-2 text-xs text-zinc-200 placeholder:text-zinc-600" />
          {state === "error" && <p className="mt-2 text-xs text-red-300" role="alert">Could not send the report. Please try again.</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 hover:text-white">Cancel</button>
            <button type="button" disabled={state === "sending"} onClick={submit} className="rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-[#171714] disabled:opacity-50">{state === "sending" ? "Sending…" : "Send report"}</button>
          </div>
        </div>
      )}
    </div>
  );
}
