"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Check, RefreshCw, Sparkles } from "lucide-react";
import { getAutoMatched, runAutoMatched, type AutoMatchedResponse } from "@/lib/api";

const money = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n)}` : "Price not specified";
};
const listingPrice = (listing: AutoMatchedResponse["requirements"][number]["matches"][number]["listing"]) => {
  if (listing.price_model === "psf" && listing.price_per_sqft != null) return `${money(listing.price_per_sqft)} / sqft`;
  return money(listing.price);
};
const priceLabel = (transaction: string | null | undefined, model: string | null | undefined) =>
  model === "psf" ? "Rate" : transaction === "rent" ? "Monthly rent" : "Asking price";

export default function AutoMatchedPage() {
  const [data, setData] = useState<AutoMatchedResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const load = async () => {
    setBusy(true);
    setLoadError("");
    try {
      setData(await getAutoMatched());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Unable to load matches.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const run = async () => {
    setBusy(true);
    setMessage("Running a bounded sample for this workspace…");
    try {
      const result = await runAutoMatched({ limit_requirements: 50, distinct_cap: 5 });
      setMessage(`${result.match_rows_written ?? 0} match rows written. Refreshing…`);
      await load();
    } catch (e) {
      const raw = e instanceof Error ? e.message : "";
      setMessage(raw.includes("409")
        ? "The sample produced a duplicate match pair before saving. The matcher needs a retry after deduplication."
        : raw || "Matching failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const messageIsError = /failed|duplicate|unable|could not/i.test(message);
  return <main className="mx-auto max-w-7xl px-5 py-10 lg:px-8">
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-accent">Workspace intelligence</p><h1 className="text-3xl font-semibold tracking-tight text-text-primary">Auto Matched</h1><p className="mt-2 max-w-2xl text-sm text-text-muted">Open requirements with the strongest active listings, ranked by the facts that matched.</p></div>
      <button onClick={run} disabled={busy} className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-60"><Sparkles size={16}/>{busy ? "Working…" : "Run sample match"}</button>
    </div>
    {message && <p role={messageIsError ? "alert" : "status"} className={`mb-5 rounded-xl border px-4 py-3 text-sm ${messageIsError ? "border-danger/30 bg-danger/5 text-text-primary" : "border-border-subtle bg-surface-raised text-text-muted"}`}>{message}</p>}
    {loadError ? <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 p-8"><p className="font-medium text-text-primary">Matches could not be loaded</p><p className="mt-1 text-sm text-text-muted">{loadError}</p><button type="button" onClick={() => void load()} disabled={busy} className="mt-5 inline-flex items-center gap-2 rounded-xl border border-border-subtle bg-surface-raised px-4 py-2.5 text-sm font-semibold text-text-primary disabled:opacity-60"><RefreshCw size={15} className={busy ? "animate-spin" : ""}/>Try again</button></div> : !data ? <div aria-live="polite" className="rounded-2xl border border-border-subtle bg-surface-raised p-8 text-sm text-text-muted">Loading workspace matches…</div> : data.requirements.length === 0 ? <div className="rounded-2xl border border-border-subtle bg-surface-raised p-10 text-center"><p className="font-medium text-text-primary">No qualified matches yet</p><p className="mt-1 text-sm text-text-muted">Run the bounded sample after the matcher has current listings and requirements.</p></div> : <>
      <div className="mb-6 flex gap-3 text-sm text-text-muted"><span className="rounded-full border border-border-subtle bg-surface-raised px-3 py-1.5">{data.total_requirements} requirements</span><span className="rounded-full border border-border-subtle bg-surface-raised px-3 py-1.5">{data.total_matches} matches</span></div>
      <div className="space-y-8">{data.requirements.map(({ requirement, matches }) => <section key={requirement.id} className="rounded-2xl border border-border-subtle bg-surface-raised p-5 shadow-sm"><div className="mb-4 flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-accent">{requirement.req_type?.replaceAll("_", " ")}</p><h2 className="mt-1 text-lg font-semibold text-text-primary">{requirement.bhk_options?.length ? `${requirement.bhk_options.join(", ")} BHK` : "Property requirement"}{requirement.micro_market ? ` in ${requirement.micro_market}` : ""}</h2><p className="mt-1 text-sm text-text-muted">Budget {money(requirement.budget_min)}{requirement.budget_max && requirement.budget_max !== requirement.budget_min ? ` – ${money(requirement.budget_max)}` : ""}</p></div><ArrowRight size={18} className="text-text-muted"/></div><div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{matches.map(({ match, listing }) => <article key={listing.id} className="rounded-xl border border-border-subtle bg-background p-4"><div className="flex items-center justify-between gap-3"><span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-bold text-accent">{Math.round(match.match_score)}% match</span><span className="text-xs text-text-muted">{listing.transaction_type}</span></div><h3 className="mt-3 line-clamp-2 font-semibold text-text-primary">{listing.summary_title || listing.building_name || "Listing"}</h3><p className="mt-1 text-sm text-text-muted">{listing.locality_resolved || listing.micro_market || "Location not specified"}</p><p className="mt-4 text-[10px] font-semibold uppercase tracking-wider text-text-muted">{priceLabel(listing.transaction_type, listing.price_model)}</p><p className="text-xl font-semibold text-accent">{listingPrice(listing)}</p><div className="mt-4 flex flex-wrap gap-1.5 text-[11px] text-text-muted">{[[match.building_match,"Building"],[match.market_match,"Market"],[match.bhk_match,"BHK"],[match.price_match !== null,"Budget"]].filter(([ok]) => Boolean(ok)).map(([, label]) => <span key={String(label)} className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1"><Check size={11}/>{label}</span>)}</div></article>)}</div></section>)}</div>
    </>}
  </main>;
}
