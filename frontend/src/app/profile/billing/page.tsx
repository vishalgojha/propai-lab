"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, MessageCircle, Network } from "lucide-react";

export function BillingPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 lg:px-6 pt-12 pb-12">
      <div className="mb-8">
        <h2 className="text-lg font-bold text-white">Billing & Plan</h2>
        <p className="mt-1 text-sm text-zinc-500">Subscription details, usage limits, and invoices</p>
      </div>

      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-300">PropAI Broker OS</p>
            <h3 className="mt-2 text-xl font-bold text-white">Your workspace plan</h3>
            <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
              Choose the way you want to work with PropAI. Both plans keep your brokerage workspace private.
            </p>
          </div>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">
            7-day MCP access
          </span>
        </div>

        <div className="grid gap-3 py-6 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <Network className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">MCP only</p>
            <p className="mt-2 text-2xl font-bold text-white">₹799 <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">Claude-connected private inventory, search, matching, and drafts.</p>
          </div>
          <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-4">
            <MessageCircle className="h-5 w-5 text-amber-300" />
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">WhatsApp self-chat agent</p>
            <p className="mt-2 text-2xl font-bold text-amber-300">₹1,999 <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">Everything in MCP, plus the agent in your own WhatsApp self-chat. No free trial for this plan.</p>
          </div>
        </div>

        <p className="text-sm leading-6 text-zinc-400">
          <Check className="mr-2 inline h-4 w-4 text-emerald-300" /> MCP includes 7 days free after your first connection. WhatsApp self-chat is paid with no trial; the configured owner number remains exempt from lockouts.
        </p>
      </div>
    </div>
  );
}

export default function LegacyBillingPage() {
  const router = useRouter();
  useEffect(() => { router.replace("/account?tab=billing"); }, [router]);
  return null;
}
