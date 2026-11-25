"use client";

import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { INSTINCT_MANUAL_SETUP, INSTINCT_MANUAL_WRITE_RULES } from "@/lib/instinctManualSetup";

export default function InstinctManualSetup() {
  const [copied, setCopied] = useState(false);

  async function copySetup() {
    await navigator.clipboard.writeText(INSTINCT_MANUAL_SETUP + INSTINCT_MANUAL_WRITE_RULES);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-4">
      <div className="flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">
        <span className="flex items-center gap-2"><ClipboardList className="h-3.5 w-3.5" aria-hidden="true" /> Manual setup instruction, if you prefer</span>
        <span>REST · read-only</span>
      </div>
      <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/10 p-3 text-sm leading-6 text-emerald-200">{INSTINCT_MANUAL_SETUP}</pre>
      <button type="button" onClick={() => void copySetup()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-300 px-4 py-2.5 text-sm font-semibold text-black hover:bg-emerald-200">
        <ClipboardList className="h-4 w-4" aria-hidden="true" /> {copied ? "Copied for Instinct" : "Copy instruction"}
      </button>
      <p className="mt-3 text-sm leading-6 text-zinc-400">The approval-link PropAI connection needs no secret for you to create or copy. Your PropAI email and password are not a connection credential. Private messages are not captured or available to external agents.</p>
    </div>
  );
}
