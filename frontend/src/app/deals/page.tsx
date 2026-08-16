"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Megaphone, Pencil, RefreshCw, Save, X } from "lucide-react";
import { getMyDeals, mergeMyDeal, updateParsedObservation } from "@/lib/api";

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
  if (!commercial) fields.splice(3, 0, ["bhk", "Configuration", "text"]);
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

function configurationLabel(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  if (/^\d+(?:\.\d+)?$/i.test(raw)) return `${raw} BHK`;
  if (/^\d+(?:\.\d+)?\s*(?:BHK|RK)$/i.test(raw)) return raw.replace(/\s+/g, " ").toUpperCase();
  return raw;
}

function evidenceLabel(deal: Deal) {
  if (text(deal.source).toLowerCase() === "mcp" || text(deal.source_scope).toLowerCase() === "mcp") {
    return "Saved via PropAI MCP";
  }
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

function formatMoneyAmount(value: number) {
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(2).replace(/\.00$/, "")} Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(2).replace(/\.00$/, "")} Lakh`;
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

function money(value: unknown, type: string, minimum?: unknown, maximum?: unknown) {
  const min = Number(minimum);
  const max = Number(maximum);
  if (type === "requirement" && Number.isFinite(min) && min > 0 && Number.isFinite(max) && max > min) {
    return `${formatMoneyAmount(min)}–${formatMoneyAmount(max)} budget`;
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "Price on request";
  const suffix = type === "requirement" ? " budget" : "";
  return `${formatMoneyAmount(amount)}${suffix}`;
}

function dateLabel(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function displayTitle(deal: Deal) {
  const existing = text(deal.summary_title);
  const isRequirement = deal.message_type === "requirement";
  const configuration = configurationLabel(deal.configuration_type || deal.bhk_options || deal.bhk);
  const transaction = text(deal.transaction_type).toLowerCase() === "rent" ? "for Rent" : text(deal.transaction_type).toLowerCase() === "sale" ? "for Sale" : "Listing";
  const building = text(deal.building_name);
  const locality = text(deal.micro_market || deal.locality_resolved || deal.locality_raw || deal.location_raw);
  const location = building && locality ? `${building} in ${locality}` : building || locality;
  if (isRequirement) {
    const requirementLabel = configuration || text(deal.commercial_use_type || deal.property_type) || "Commercial";
    const budget = money(deal.price, "requirement", deal.budget_min, deal.budget_max).replace(/ budget$/, "");
    return [`Requirement: ${requirementLabel}${location ? ` in ${location}` : ""}`, budget ? `— ${budget}` : ""].filter(Boolean).join(" ");
  }
  const unusableTitle = /^\[unstructured\]|^(?:unknown|listing)$/i.test(existing);
  if (existing && !unusableTitle && !/^\d+(?:\.\d+)?\s*bhk\s*listing$/i.test(existing)) return existing;
  return [configuration, transaction, location ? `— ${location}` : ""].filter(Boolean).join(" ") || (isRequirement ? "Needs review — incomplete requirement" : "Needs review — incomplete listing");
}

function listingContact(deal: Deal) {
  const name = text(deal.broker_name);
  const digits = text(deal.broker_phone).replace(/\D/g, "");
  if (!name && !digits) return null;
  return { name: name || "Listing contact", digits };
}

export default function DealsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "listing" | "requirement">("all");
  const [recordFilter, setRecordFilter] = useState<"unique" | "all" | "review">("unique");
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [merging, setMerging] = useState(false);
  const [selectedDuplicates, setSelectedDuplicates] = useState<Set<string>>(new Set());
  const [savedId, setSavedId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await getMyDeals(100));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your inventory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const needsReview = (row: Deal) => row.duplicate_status === "flagged" || /^\[unstructured\]|^unknown$|^listing$/i.test(text(row.summary_title));
  const countFor = (value: "all" | "listing" | "requirement") => {
    let next = value === "all" ? rows : rows.filter((row) => row.message_type === value);
    if (recordFilter === "unique") next = next.filter((row) => row.duplicate_status !== "flagged" && !needsReview(row));
    if (recordFilter === "review") next = next.filter(needsReview);
    return next.length;
  };
  const visible = useMemo(() => {
    let next = filter === "all" ? rows : rows.filter((row) => row.message_type === filter);
    if (recordFilter === "unique") next = next.filter((row) => row.duplicate_status !== "flagged" && !needsReview(row));
    if (recordFilter === "review") next = next.filter(needsReview);
    return next;
  }, [filter, recordFilter, rows]);

  function duplicateTarget(row: Deal): Deal | null {
    const schema = text(row.possible_duplicate_source_table);
    const id = Number(row.possible_duplicate_source_id || 0);
    if (!schema || !id) return null;
    return rows.find((candidate) => text(candidate.source_schema) === schema && Number(candidate.id) === id) || null;
  }

  function rowKey(row: Deal) {
    return `${row.source_schema || ""}:${row.id}`;
  }

  function sendToSocialFlow(row: Deal) {
    if (row.message_type === "requirement" || !row.source_schema) return;
    const params = new URLSearchParams({
      listing_schema: row.source_schema,
      listing_id: String(row.id),
    });
    router.push(`/social-flow?${params.toString()}`);
  }

  async function mergeSelected() {
    const candidates = visible.filter((row) => selectedDuplicates.has(rowKey(row)) && row.duplicate_status === "flagged" && row.possible_duplicate_source_table && row.possible_duplicate_source_id);
    const targetKeys = new Set(candidates.map((row) => `${row.possible_duplicate_source_table}:${row.possible_duplicate_source_id}`));
    const sources = candidates.filter((row) => !targetKeys.has(rowKey(row)));
    if (!sources.length) return;
    if (!window.confirm(`Merge ${sources.length} selected duplicate${sources.length === 1 ? "" : "s"} into their suggested records? Original WhatsApp evidence will remain preserved.`)) return;
    setMerging(true);
    setError("");
    try {
      for (const row of sources) {
        await mergeMyDeal(row.source_schema || "", row.id, row.possible_duplicate_source_table, Number(row.possible_duplicate_source_id));
      }
      setSelectedDuplicates(new Set());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not merge selected duplicates");
    } finally {
      setMerging(false);
    }
  }

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
    <main className="min-h-full px-3 py-5 sm:px-7 sm:py-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="propai-kicker text-[10px] font-semibold">Broker workspace · live evidence</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-white">My Deals</h1>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">Your broker CRM for listings and requirements from WhatsApp groups, self-chat, WABA API, AI Chat, and MCP. Edit missing details without losing the original evidence.</p>
          </div>
          <button onClick={() => void load()} className="propai-control inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-zinc-300" disabled={loading}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} /> Refresh
          </button>
        </div>

        <div className="propai-panel mt-6 flex flex-wrap items-center gap-2 rounded-xl p-2">
          {(["all", "listing", "requirement"] as const).map((value) => (
            <button key={value} onClick={() => setFilter(value)} className={`h-8 rounded-lg px-3 text-xs font-medium transition-colors ${filter === value ? "bg-white/[0.09] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,.09)]" : "text-zinc-400 hover:bg-white/[0.04] hover:text-white"}`}>
              {value === "all" ? "All" : value === "listing" ? "Listings" : "Requirements"} <span className="ml-1 text-zinc-500">{countFor(value)}</span>
            </button>
          ))}
          <select value={recordFilter} onChange={(event) => setRecordFilter(event.target.value as typeof recordFilter)} className="propai-control h-8 rounded-lg px-2.5 text-xs text-zinc-300 outline-none">
            <option value="unique">Unique only</option>
            <option value="all">All records</option>
            <option value="review">Needs review</option>
          </select>
          <Link href="/chat" className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-[#07110b] hover:bg-accent-hover">Save from AI Chat <ExternalLink className="h-3.5 w-3.5" /></Link>
          {selectedDuplicates.size > 0 && <button onClick={() => void mergeSelected()} disabled={merging} className="inline-flex h-8 items-center rounded-lg border border-violet-300/30 px-3 text-xs font-medium text-violet-200 disabled:opacity-50">{merging ? "Merging…" : `Merge selected (${selectedDuplicates.size})`}</button>}
        </div>

        {error && <div className="mt-4 rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-sm text-red-300">{error}</div>}
        {loading && <div className="py-16 text-center text-sm text-zinc-500">Loading your saved CRM records…</div>}
        {!loading && !error && visible.length === 0 && (
          <div className="propai-panel mt-8 rounded-2xl border-dashed px-5 py-14 text-center">
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
            const isFlaggedDuplicate = row.duplicate_status === "flagged";
            const isEditing = editing === row.id;
            const duplicate = isFlaggedDuplicate ? duplicateTarget(row) : null;
            return (
              <article key={`${row.source_schema}-${row.id}`} className="propai-panel group rounded-2xl p-4 transition-colors hover:border-white/[0.12] sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide">
                      <span className={`rounded-full border px-2.5 py-1 ${isRequirement ? "border-violet-300/20 bg-violet-300/[0.07] text-violet-200" : "border-cyan-300/20 bg-cyan-300/[0.06] text-cyan-200"}`}>{isRequirement ? "Requirement" : "Listing"}</span>
                      <span className="text-zinc-500">{text(row.transaction_type || row.intent)}</span>
                      <span className="text-zinc-600">{schemaLabel(row)}</span>
                      {savedId === row.id && <span className="inline-flex items-center gap-1 text-emerald-300 normal-case tracking-normal"><Check className="h-3.5 w-3.5" /> Shared to PropAI discovery</span>}
                      {isFlaggedDuplicate && <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-violet-300/30 bg-violet-300/[0.08] px-2.5 py-1 text-violet-200 normal-case tracking-normal"><input type="checkbox" checked={selectedDuplicates.has(rowKey(row))} onChange={() => setSelectedDuplicates((current) => { const next = new Set(current); const key = rowKey(row); if (next.has(key)) next.delete(key); else next.add(key); return next; })} className="accent-violet-400" /> Select duplicate</label>}
                    </div>
                    <h2 className="mt-2 text-base font-medium text-white">{displayTitle(row)}</h2>
                    {(row.source_timestamp || row.created_at || row.last_seen || row.last_seen_at) && <p className="mt-1 text-xs text-zinc-500">Captured {dateLabel(row.source_timestamp || row.created_at)}{(row.last_seen || row.last_seen_at) && <> · Last seen {dateLabel(row.last_seen || row.last_seen_at)}</>}</p>}
                    {!isRequirement && Number(row.repost_count || 1) > 1 && <p className="mt-1 text-xs text-emerald-300">Posted {Number(row.repost_count)}× across {Array.isArray(row.repost_source_groups) && row.repost_source_groups.length ? `${row.repost_source_groups.length} groups` : "multiple sources"} · last active {text(row.last_posted_at || row.last_seen || row.created_at)}</p>}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-400">
                      {text(row.micro_market || row.location_raw) && <span>{text(row.micro_market || row.location_raw)}</span>}
                      {configurationLabel(row.configuration_type || row.bhk_options || row.bhk) && <span>{configurationLabel(row.configuration_type || row.bhk_options || row.bhk)}</span>}
                      {text(row.area_sqft) && <span>{Number(row.area_sqft).toLocaleString("en-IN")} sq ft</span>}
                      <span className="text-emerald-300">{money(row.price, row.message_type || "listing", row.budget_min, row.budget_max)}</span>
                    </div>
                    {(() => {
                      const contact = listingContact(row);
                      if (!contact) return <p className="mt-2 text-xs text-zinc-600">Listing contact not captured</p>;
                      return <p className="mt-2 text-xs text-zinc-500">Listing contact: {contact.name}{contact.digits && <> · <a className="text-emerald-300 hover:underline" href={`https://wa.me/${contact.digits}`} target="_blank" rel="noreferrer">WhatsApp</a></>}</p>;
                    })()}
                  </div>
                  {!isEditing && <div className="flex flex-wrap items-center justify-end gap-2">
                    {!isRequirement && <button type="button" onClick={() => sendToSocialFlow(row)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-300/20 bg-emerald-300/[0.06] px-2.5 text-xs text-emerald-200 hover:border-emerald-300/40"><Megaphone className="h-3.5 w-3.5" /> Send to Social Flow</button>}
                    <button type="button" onClick={() => beginEdit(row)} className="propai-control inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-300"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  </div>}
                </div>

                {isEditing && <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2 lg:grid-cols-3">
                  {editFieldsFor(row).map(([key, label, type]) => <label key={key} className="text-xs text-zinc-400">{label}<input type={type} placeholder={fieldPlaceholder(key)} value={draft[key] || ""} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-black/20 px-2.5 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-400/50" /></label>)}
                  <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3"><button onClick={() => void save(row)} disabled={saving} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-400 px-3 text-sm font-medium text-black"><Save className="h-4 w-4" /> {saving ? "Saving…" : "Save & share to PropAI"}</button><button onClick={() => setEditing(null)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-white/10 px-3 text-sm text-zinc-300"><X className="h-4 w-4" /> Cancel</button></div>
                </div>}

                <details className="mt-4 border-t border-white/[0.07] pt-3"><summary className="cursor-pointer text-xs font-medium text-zinc-500 hover:text-cyan-200">{text(row.source).toLowerCase() === "mcp" || text(row.source_scope).toLowerCase() === "mcp" ? "MCP evidence" : "WhatsApp evidence"} · {evidenceLabel(row)}</summary><div className="mt-3 whitespace-pre-wrap rounded-xl border border-white/[0.06] bg-black/20 p-3 text-xs leading-5 text-zinc-400">{text(row.source_message || row.raw_message || row.normalized_message) || "Original WhatsApp message is unavailable for this record."}</div><p className="mt-2 text-[11px] text-zinc-600">{text(row.source).toLowerCase() === "mcp" || text(row.source_scope).toLowerCase() === "mcp" ? "Saved via PropAI MCP · edits update the typed record and preserve the original source." : "Original message captured from your connected WhatsApp · edits update the typed record and preserve the original source."}</p></details>
                {duplicate && <p className="mt-2 text-xs text-violet-200/80 normal-case tracking-normal">Possible duplicate of: {displayTitle(duplicate)} · posted {dateLabel(duplicate.source_timestamp || duplicate.created_at || duplicate.last_seen)}</p>}
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}
