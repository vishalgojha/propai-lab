"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Pencil, RefreshCw, Save, X } from "lucide-react";
import { getMyDeals, updateParsedObservation } from "@/lib/api";

type Deal = Record<string, any> & {
  id: number;
  message_type?: "listing" | "requirement";
  source_schema?: string;
  raw_message_id?: number;
};

type Draft = Record<string, string>;

type EditField = readonly [string, string, "number" | "text"];

function editFieldsFor(deal: Deal): EditField[] {
  const isRequirement = deal.message_type === "requirement";
  const commercial = text(deal.asset_type).toLowerCase() === "commercial";
  const rent = text(deal.transaction_type).toLowerCase() === "rent";
  if (isRequirement) {
    return [
      ["summary_title", "Requirement title", "text"],
      ["micro_market_options", "Localities", "text"],
      ["bhk_options", "Configurations", "text"],
      ["budget_min", "Minimum budget (₹)", "number"],
      ["budget_max", "Maximum budget (₹)", "number"],
      ["carpet_area_min_sqft", "Minimum carpet area (sq ft)", "number"],
      ["carpet_area_max_sqft", "Maximum carpet area (sq ft)", "number"],
      ["furnishing_preference", "Furnishing preference", "text"],
      ["possession_preference", "Possession preference", "text"],
      ["urgency", "Urgency", "text"],
      ["status", "Requirement status", "text"],
      ["building_preferences", "Building preferences", "text"],
      ...(rent ? [
        ["deposit_budget_max", "Maximum deposit (₹)", "number"],
        ["tenant_type", "Tenant type", "text"],
        ["has_pets", "Pets", "text"],
        ["lease_term_preference", "Lease term preference", "text"],
      ] as EditField[] : []),
    ];
  }
  const fields: EditField[] = [
    ["summary_title", "Listing title", "text"],
    ["building_name", "Building / property", "text"],
    ["micro_market", "Locality", "text"],
    ["bhk", "Configuration", "text"],
    ["price", rent ? "Monthly rent (₹)" : "Asking price (₹)", "number"],
    ["area_sqft", "Area (sq ft)", "number"],
    ["furnishing", "Furnishing", "text"],
    ["floor_range", "Floor", "text"],
    ["parking_type", "Parking", "text"],
    ["car_parking_count", "Car parks", "number"],
  ];
  if (rent) fields.push(
    ["deposit_amount", "Deposit (₹)", "number"],
    ["deposit_months", "Deposit (months)", "number"],
    ["lease_term_type", "Lease term", "text"],
    ["pet_policy", "Pet policy", "text"],
    ["availability_status", "Availability", "text"],
    ["available_from", "Available from", "text"],
  );
  else fields.push(
    ["price_per_sqft", "Price / sq ft (₹)", "number"],
    ["possession_status", "Possession status", "text"],
    ["possession_date", "Possession date", "text"],
  );
  if (commercial) fields.push(["commercial_use_type", "Commercial use", "text"], ["fitout_status", "Fit-out", "text"]);
  return fields;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function evidenceLabel(deal: Deal) {
  const source = text(deal.source_group);
  // Never expose the connected account's JID/phone in the CRM. A JID here is
  // an ingestion identifier, not a meaningful source name for the broker.
  if (!source || /@(g\.us|s\.whatsapp\.net|lid)$/i.test(source) || /^\+?\d{8,}$/.test(source)) {
    return "Your connected WhatsApp inventory";
  }
  return `Your connected WhatsApp · ${source}`;
}

function schemaLabel(deal: Deal) {
  const asset = text(deal.asset_type).toLowerCase() === "commercial" ? "Commercial" : "Residential";
  const transaction = text(deal.transaction_type).toLowerCase() === "rent" ? "Rent" : "Sale";
  return `${asset} ${transaction} ${deal.message_type === "requirement" ? "requirement" : "listing"}`;
}

function fieldValue(row: Deal, key: string) {
  const value = row[key];
  return Array.isArray(value) ? value.join(", ") : text(value);
}

function fieldPlaceholder(key: string) {
  const placeholders: Record<string, string> = {
    summary_title: "e.g. 2 BHK for Rent in Bandra West",
    building_name: "e.g. Rustomjee Seasons",
    micro_market: "e.g. Bandra West",
    micro_market_options: "e.g. Bandra West, Khar West",
    bhk: "e.g. 2 BHK",
    bhk_options: "e.g. 1 BHK, 2 BHK",
    price: "e.g. 25000000",
    budget_min: "e.g. 75000",
    budget_max: "e.g. 85000",
    area_sqft: "e.g. 1100",
    carpet_area_min_sqft: "e.g. 900",
    carpet_area_max_sqft: "e.g. 1400",
    furnishing: "e.g. Fully furnished",
    furnishing_preference: "e.g. Semi furnished",
    floor_range: "e.g. Higher floor",
    parking_type: "e.g. Covered parking",
    car_parking_count: "e.g. 1",
    deposit_amount: "e.g. 500000",
    deposit_budget_max: "e.g. 500000",
    deposit_months: "e.g. 6",
    lease_term_type: "e.g. 3 years",
    lease_term_preference: "e.g. 2 years",
    pet_policy: "e.g. Pets allowed",
    has_pets: "e.g. Yes / No",
    availability_status: "e.g. Listed / Available from date",
    available_from: "e.g. 1 Sep 2026",
    possession_status: "e.g. Ready possession",
    possession_preference: "e.g. Immediate / Ready possession",
    possession_date: "e.g. Dec 2026",
    urgency: "e.g. Immediate",
    status: "e.g. Active",
    building_preferences: "e.g. Rustomjee, Lodha",
    tenant_type: "e.g. Family / Company lease",
    tenant_type_preference: "e.g. Family",
    commercial_use_type: "e.g. Office / Retail",
    fitout_status: "e.g. Warm shell / Furnished",
    price_per_sqft: "e.g. 45000",
  };
  return placeholders[key] || "Enter the verified property detail";
}

function money(value: unknown, type: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "Price on request";
  const suffix = type === "requirement" ? " budget" : "";
  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2).replace(/\.00$/, "")} Cr${suffix}`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(2).replace(/\.00$/, "")} L${suffix}`;
  return `₹${Math.round(amount).toLocaleString("en-IN")}${suffix}`;
}

function displayTitle(deal: Deal) {
  const existing = text(deal.summary_title);
  if (existing && !/^\d+(?:\.\d+)?\s*bhk\s*listing$/i.test(existing) && existing.toLowerCase() !== "listing") return existing;
  const configuration = text(deal.configuration_type || deal.bhk);
  const transaction = text(deal.transaction_type).toLowerCase() === "rent" ? "for Rent" : text(deal.transaction_type).toLowerCase() === "sale" ? "for Sale" : "Listing";
  const building = text(deal.building_name);
  const locality = text(deal.micro_market || deal.locality_resolved || deal.locality_raw || deal.location_raw);
  const location = building && locality ? `${building} in ${locality}` : building || locality;
  return [configuration, transaction, location ? `— ${location}` : ""].filter(Boolean).join(" ") || "Untitled property record";
}

function listingContact(deal: Deal) {
  const name = text(deal.broker_name);
  const digits = text(deal.broker_phone).replace(/\D/g, "");
  if (!name && !digits) return null;
  return { name: name || "Listing contact", digits };
}

export default function DealsPage() {
  const [rows, setRows] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "listing" | "requirement">("all");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await getMyDeals(300));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your inventory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(
    () => filter === "all" ? rows : rows.filter((row) => row.message_type === filter),
    [filter, rows],
  );

  function beginEdit(row: Deal) {
    setEditing(row.id);
    setSavedId(null);
    const next: Draft = {};
    for (const [key] of editFieldsFor(row)) next[key] = fieldValue(row, key);
    setDraft(next);
  }

  async function save(row: Deal) {
    setSaving(true);
    setError("");
    const updates: Record<string, unknown> = {};
    for (const [key] of editFieldsFor(row)) {
      const value = draft[key]?.trim() || null;
      if (["price", "area_sqft", "budget_min", "budget_max", "area_min_sqft", "area_max_sqft", "carpet_area_min_sqft", "carpet_area_max_sqft", "price_per_sqft", "car_parking_count", "deposit_amount", "deposit_months", "deposit_budget_max"].includes(key)) updates[key] = value ? Number(value.replace(/[^0-9.]/g, "")) : null;
      else if (key === "bhk_options" || key === "micro_market_options" || key === "building_preferences") updates[key] = value;
      else if (key === "micro_market") updates.micro_market = value;
      else if (key === "furnishing") updates.furnishing = value;
      else updates[key] = value;
    }
    try {
      await updateParsedObservation(row.id, row.source_schema || null, updates);
      setRows((current) => current.map((item) => item.id === row.id ? {
        ...item,
        ...draft,
        micro_market: draft.micro_market,
        location_raw: draft.micro_market,
        micro_market: draft.micro_market,
        price: draft.price ? Number(draft.price.replace(/[^0-9.]/g, "")) : null,
        area_sqft: draft.area_sqft ? Number(draft.area_sqft.replace(/[^0-9.]/g, "")) : null,
      } : item));
      setEditing(null);
      setSavedId(row.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this record");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-full bg-background px-3 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-emerald-400">Broker CRM</p>
            <h1 className="mt-1 text-2xl font-semibold text-white">My Deals</h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">Your broker CRM for listings and requirements from WhatsApp groups, self-chat, WABA API, AI Chat, and MCP. Edit missing details without losing the original evidence.</p>
          </div>
          <button onClick={() => void load()} className="inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 px-3 text-sm text-zinc-300 hover:bg-white/5" disabled={loading}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
          </button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-b border-white/10 pb-3">
          {(["all", "listing", "requirement"] as const).map((value) => (
            <button key={value} onClick={() => setFilter(value)} className={`h-8 rounded-lg border px-3 text-xs font-medium ${filter === value ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300" : "border-white/10 text-zinc-400 hover:text-white"}`}>
              {value === "all" ? "All" : value === "listing" ? "Listings" : "Requirements"} <span className="ml-1 text-zinc-500">{value === "all" ? rows.length : rows.filter((row) => row.message_type === value).length}</span>
            </button>
          ))}
          <Link href="/chat" className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-400/30 px-3 text-xs text-emerald-300 hover:bg-emerald-400/10">Save from AI Chat <ExternalLink className="h-3.5 w-3.5" /></Link>
        </div>

        {error && <div className="mt-4 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-sm text-red-300">{error}</div>}
        {loading && <div className="py-16 text-center text-sm text-zinc-500">Loading your saved CRM records…</div>}
        {!loading && !error && visible.length === 0 && (
          <div className="mt-8 rounded-xl border border-dashed border-white/15 px-5 py-12 text-center">
            <h2 className="text-base font-medium text-white">
              {filter === "listing" ? "No listings saved yet" : filter === "requirement" ? "No requirements saved yet" : "No saved records yet"}
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-zinc-400">
              {filter === "listing"
                ? "Listings saved from opted-in WhatsApp groups, self-chat, WABA API, AI Chat, or MCP will appear here."
                : filter === "requirement"
                  ? "Requirements saved from your connected channels or AI Chat will appear here."
                  : "Listings and requirements saved from your connected channels will appear here. Keep personal groups opted out, then start extraction when you are ready."}
            </p>
            <Link href="/chat" className="mt-4 inline-flex h-9 items-center rounded-lg bg-emerald-400 px-4 text-sm font-medium text-black">Open AI Chat</Link>
          </div>
        )}

        <div className="mt-4 space-y-3">
          {visible.map((row) => {
            const isRequirement = row.message_type === "requirement";
            const isEditing = editing === row.id;
            return (
              <article key={`${row.source_schema}-${row.id}`} className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide">
                      <span className={`rounded-md px-2 py-1 ${isRequirement ? "bg-amber-400/10 text-amber-300" : "bg-emerald-400/10 text-emerald-300"}`}>{isRequirement ? "Requirement" : "Listing"}</span>
                      <span className="text-zinc-500">{text(row.transaction_type || row.intent)}</span>
                      <span className="text-zinc-600">{schemaLabel(row)}</span>
                      {savedId === row.id && <span className="inline-flex items-center gap-1 text-emerald-300 normal-case tracking-normal"><Check className="h-3.5 w-3.5" /> Saved</span>}
                    </div>
                    <h2 className="mt-2 text-base font-medium text-white">{displayTitle(row)}</h2>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-400">
                      {text(row.micro_market || row.location_raw) && <span>{text(row.micro_market || row.location_raw)}</span>}
                      {text(row.bhk) && <span>{text(row.bhk)}</span>}
                      {text(row.area_sqft) && <span>{Number(row.area_sqft).toLocaleString("en-IN")} sq ft</span>}
                      <span className="text-emerald-300">{money(row.price, row.message_type || "listing")}</span>
                    </div>
                    {(() => {
                      const contact = listingContact(row);
                      if (!contact) return <p className="mt-2 text-xs text-zinc-600">Listing contact not captured</p>;
                      return <p className="mt-2 text-xs text-zinc-500">Listing contact: {contact.name}{contact.digits && <> · <a className="text-emerald-300 hover:underline" href={`https://wa.me/${contact.digits}`} target="_blank" rel="noreferrer">WhatsApp</a></>}</p>;
                    })()}
                  </div>
                  {!isEditing && <button onClick={() => beginEdit(row)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/10 px-2.5 text-xs text-zinc-300 hover:bg-white/5"><Pencil className="h-3.5 w-3.5" /> Edit</button>}
                </div>

                {isEditing && <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2 lg:grid-cols-3">
                  {editFieldsFor(row).map(([key, label, type]) => <label key={key} className="text-xs text-zinc-400">{label}<input type={type} placeholder={fieldPlaceholder(key)} value={draft[key] || ""} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-black/20 px-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-400/50" /></label>)}
                  <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3"><button onClick={() => void save(row)} disabled={saving} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-400 px-3 text-sm font-medium text-black"><Save className="h-4 w-4" /> {saving ? "Saving…" : "Save changes"}</button><button onClick={() => setEditing(null)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-sm text-zinc-300"><X className="h-4 w-4" /> Cancel</button></div>
                </div>}

                <details className="mt-4 border-t border-white/10 pt-3"><summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">WhatsApp evidence · {evidenceLabel(row)}</summary><div className="mt-2 whitespace-pre-wrap rounded-lg bg-black/20 p-3 text-xs leading-5 text-zinc-400">{text(row.source_message || row.normalized_message) || "Evidence text is unavailable for this record."}</div><p className="mt-2 text-[11px] text-zinc-600">Captured from your connected WhatsApp · source message #{row.raw_message_id || "—"} · edits update the typed record and preserve this source.</p></details>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}
