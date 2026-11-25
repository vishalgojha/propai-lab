"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Network } from "lucide-react";

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
              One PropAI through Instinct or any MCP assistant. Every plan keeps your brokerage workspace private; the only difference is how many WhatsApp numbers feed one account.
            </p>
          </div>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">
            15-day assistant access
          </span>
        </div>

        <div className="grid gap-3 py-6 sm:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <Network className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Solo</p>
            <p className="mt-2 text-2xl font-bold text-white">₹1,299 <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">1 WhatsApp number in one account, used through Instinct, Claude, or another MCP assistant. Assistant subscription separate.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <Network className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">2 numbers</p>
            <p className="mt-2 text-2xl font-bold text-white">₹1,499 <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">Everything in Solo, with 2 WhatsApp numbers connected to the same account.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <Network className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">3 numbers</p>
            <p className="mt-2 text-2xl font-bold text-white">₹2,599 <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">Everything in Solo, with 3 WhatsApp numbers connected to the same account.</p>
          </div>
        </div>

        <p className="text-sm leading-6 text-zinc-400">
          <Check className="mr-2 inline h-4 w-4 text-emerald-300" /> New workspaces include a 15-day free trial that starts with the first assistant search.
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
