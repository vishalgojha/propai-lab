"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Network } from "lucide-react";
import { createBillingSubscription, getBillingPlans, getBillingStatus, getMarketAccessStatus, type BillingPlan, type MarketAccessStatus, verifyBillingSubscription } from "@/lib/api";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Razorpay checkout could not load."));
    document.body.appendChild(script);
  });
}

export function BillingPage() {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [subscription, setSubscription] = useState<{ plan_key: string; status: string } | null>(null);
  const [trial, setTrial] = useState<MarketAccessStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void Promise.allSettled([getBillingPlans(), getBillingStatus(), getMarketAccessStatus()]).then((results) => {
      if (cancelled) return;

      const [plansResult, statusResult, accessResult] = results;
      const failures: string[] = [];

      if (plansResult.status === "fulfilled") {
        setPlans(plansResult.value.plans);
      } else {
        failures.push("plan options");
      }

      if (statusResult.status === "fulfilled") {
        setSubscription(statusResult.value.subscription);
      } else {
        failures.push("subscription status");
      }

      // Trial/market access is advisory on this screen. A failure here must
      // not hide the billing plan or subscription controls.
      if (accessResult.status === "fulfilled") {
        setTrial(accessResult.value);
      }

      if (failures.length) {
        setMessage(`Unable to load ${failures.join(" and ")}. Please try again.`);
      }
    });

    return () => { cancelled = true; };
  }, []);

  async function startCheckout(plan: BillingPlan) {
    setBusy(plan.key);
    setMessage(null);
    try {
      const created = await createBillingSubscription(plan.key);
      await loadRazorpayCheckout();
      if (!window.Razorpay) throw new Error("Razorpay checkout is unavailable.");
      const checkout = new window.Razorpay({
        key: created.key_id,
        subscription_id: created.subscription_id,
        name: "PropAI",
        description: `${plan.label} workspace plan`,
        handler: async (response: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }) => {
          try {
            await verifyBillingSubscription(response);
            setSubscription({ plan_key: plan.key, status: "authenticated" });
            setMessage("Payment verified. Your workspace plan is being activated.");
          } catch {
            setMessage("Payment completed, but verification is still pending. Please refresh shortly.");
          }
        },
        modal: { ondismiss: () => setBusy(null) },
        theme: { color: "#3EE88A" },
      });
      checkout.open();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start checkout.");
      setBusy(null);
    }
  }

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
            {trial?.trial_state === "active" ? "Free trial active" : "15-day assistant access"}
          </span>
        </div>

        {message && <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100" role="status">{message}</div>}
        <div className="grid gap-3 py-6 sm:grid-cols-3">
          {(plans.length ? plans : [
            { key: "solo", label: "Solo", amount: 1299, numbers: 1 },
            { key: "two_numbers", label: "2 numbers", amount: 1499, numbers: 2 },
            { key: "three_numbers", label: "3 numbers", amount: 2599, numbers: 3 },
          ]).map((plan) => <div key={plan.key} className="rounded-xl border border-white/10 bg-black/10 p-4">
            <Network className="h-5 w-5 text-emerald-300" />
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">{plan.label}</p>
            <p className="mt-2 text-2xl font-bold text-white">₹{plan.amount.toLocaleString("en-IN")} <span className="text-sm font-medium text-zinc-400">/ month</span></p>
            <p className="mt-1 text-sm text-zinc-400">{plan.numbers} WhatsApp number{plan.numbers === 1 ? "" : "s"} in one workspace, used through Instinct or another assistant.</p>
            <button type="button" onClick={() => void startCheckout(plan)} disabled={busy !== null || subscription?.status === "active"} className="mt-4 w-full rounded-lg bg-emerald-300 px-3 py-2 text-sm font-bold text-[#061015] hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50">{busy === plan.key ? "Opening checkout…" : subscription?.plan_key === plan.key ? `Current · ${subscription.status}` : "Choose plan"}</button>
          </div>)}
        </div>

        <p className="text-sm leading-6 text-zinc-400">
          <Check className="mr-2 inline h-4 w-4 text-emerald-300" /> Free assistant access starts with the first successful search. Instinct can read the exact days remaining from your workspace; if you ask for a reminder, it can schedule one 3 days and 1 day before the end date.
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
