"use client";

import { useShortlist, buildShortlistMessage } from "@/components/ShortlistProvider";
import { useAnalytics } from "@/lib/useAnalytics";
import { MessageSquare, X } from "lucide-react";

// Floating bar shown when the visitor has shortlisted one or more listings.
// "Send" opens wa.me with a prefilled bundle of all selected listings so the
// client can forward it to any broker/contact themselves — no sign-up.
export default function ShortlistBar() {
  const { items, count, clear } = useShortlist();
  const { track } = useAnalytics();

  if (count === 0) return null;

  function send() {
    const text = buildShortlistMessage(items);
    track("bundle_send", { extra: { count } });
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    clear();
  }

  return (
    <div className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/95 px-4 py-3 shadow-[0_20px_60px_rgba(0,0,0,0.5)] backdrop-blur">
        <span className="text-sm text-zinc-300">
          <span className="font-semibold text-white">{count}</span> shortlisted
        </span>
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-white transition-colors"
          aria-label="Clear shortlist"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" /> Clear
        </button>
        <button
          type="button"
          onClick={send}
          className="inline-flex items-center gap-2 rounded-xl bg-green-400 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-green-300"
        >
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          Send to broker
        </button>
      </div>
    </div>
  );
}
