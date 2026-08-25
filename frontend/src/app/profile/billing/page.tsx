"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

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
              Try PropAI free for 15 days. After the trial, the plan is ₹1,499 per month.
            </p>
          </div>
          <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-200">
            15-day free trial
          </span>
        </div>

        <div className="grid gap-3 py-6 sm:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/10 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Trial period</p>
            <p className="mt-2 text-2xl font-bold text-white">15 days</p>
            <p className="mt-1 text-sm text-zinc-400">Full workspace access during your trial.</p>
          </div>
          <div className="rounded-xl border border-amber-300/20 bg-amber-300/[0.06] p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">After trial</p>
            <p className="mt-2 text-2xl font-bold text-amber-300">₹1,499 <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">Subscription pricing for the workspace.</p>
          </div>
        </div>

        <p className="text-sm leading-6 text-zinc-400">
          Payment and plan controls are being connected. Your trial and subscription status will appear here once billing is live.
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
