"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock3, ExternalLink, RefreshCw, Search, X, Zap } from "lucide-react";
import { fetchJSON, retryExtraction } from "@/lib/api";

type ExtractionRow = {
  id: number;
  raw_message_id: number;
  raw_group?: string | null;
  raw_timestamp?: string | null;
  created_at?: string | null;
  broker_name?: string | null;
  broker_phone?: string | null;
  building_name?: string | null;
  micro_market?: string | null;
  location_raw?: string | null;
  intent?: string | null;
  message_type?: string | null;
  asset_type?: string | null;
  transaction_type?: string | null;
  bhk?: string | number | null;
  price?: number | null;
  price_unit?: string | null;
  price_model?: string | null;
  price_per_sqft?: number | null;
  area_sqft?: number | null;
  area_min_sqft?: number | null;
  area_max_sqft?: number | null;
  furnishing?: string | null;
  possession_status?: string | null;
  confidence?: number | string | null;
  extraction_confidence?: string | null;
  extraction_confidence_score?: number | null;
  needs_review?: boolean | null;
  validation_flags?: unknown[] | Record<string, unknown> | null;
  source_schema?: string | null;
  summary_title?: string | null;
  raw_payload?: { landmark_options?: unknown; [key: string]: unknown } | string | null;
  ai_extraction?: Record<string, unknown> | string | null;
};

type Progress = {
  total_raw_messages: number | null;
  pending: number | null;
  suppressed?: number;
  eligible_pending?: number | null;
  processed: number | null;
  recently_processed: number | null;
  rate_window_hours: number;
  progress_pct: number | null;
  degraded?: boolean;
  warning?: string;
};

type RawEvidence = {
  id: number;
  message?: string | null;
  group_name?: string | null;
  sender?: string | null;
  sender_phone?: string | null;
  timestamp?: string | null;
};

function formatPrice(row: ExtractionRow) {
  const value = row.price ?? row.price_per_sqft;
  if (value == null) return "Price not found";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Price needs review";
  const formatted = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return row.price_per_sqft != null && row.price == null ? `₹${formatted}/sqft` : `₹${formatted}`;
}

function isRequirement(row: ExtractionRow) {
  return row.message_type === "requirement" || row.source_schema?.endsWith("_requirements");
}

function landmarkOptions(row: ExtractionRow): string[] {
  const payload = typeof row.raw_payload === "string" ? (() => { try { return JSON.parse(row.raw_payload as string); } catch { return null; } })() : row.raw_payload;
  return Array.isArray(payload?.landmark_options) ? payload.landmark_options.map(String).filter(Boolean).slice(0, 8) : [];
}

function extractionKind(row: ExtractionRow) {
  return isRequirement(row) ? "Requirement" : "Listing";
}

function parserLabel(row: ExtractionRow) {
  const value = typeof row.ai_extraction === "string"
    ? (() => { try { return JSON.parse(row.ai_extraction as string); } catch { return null; } })()
    : row.ai_extraction;
  return value && typeof value === "object" && Object.keys(value).length > 0 ? "AI parsed" : "Legacy / provenance unavailable";
}

function extractionProvenance(row: ExtractionRow) {
  const value = typeof row.ai_extraction === "string"
    ? (() => { try { return JSON.parse(row.ai_extraction as string); } catch { return null; } })()
    : row.ai_extraction;
  const provenance = value && typeof value === "object" && value.extraction_provenance && typeof value.extraction_provenance === "object"
    ? value.extraction_provenance as { provider?: unknown; model?: unknown; extracted_at?: unknown }
    : null;
  if (!provenance?.provider) return null;
  return `${String(provenance.provider)}${provenance.model ? ` · ${String(provenance.model)}` : ""}`;
}

function formatDate(value?: string | null) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function confidence(row: ExtractionRow) {
  const numeric = Number(row.extraction_confidence_score ?? row.confidence);
  if (Number.isFinite(numeric)) return `${Math.round(numeric * 100)}% confidence`;
  return row.extraction_confidence ? `${row.extraction_confidence} confidence` : "Confidence unavailable";
}

function sourceContext(value: string | number | null | undefined, message?: string | null) {
  const wanted = String(value ?? "").trim();
  const lines = String(message || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!wanted || !lines.length) return null;
  const tokens = wanted.toLowerCase().match(/[a-z0-9]+/g) || [];
  if (!tokens.length) return null;
  const match = lines.find((line) => {
    const haystack = line.toLowerCase();
    const matched = tokens.filter((token) => haystack.includes(token));
    return matched.length >= Math.max(1, Math.ceil(tokens.length * 0.6));
  });
  return match || null;
}

function EvidenceTrace({ label, value, message }: { label: string; value?: string | number | null; message?: string | null }) {
  const context = sourceContext(value, message);
  const present = Boolean(value);
  return (
    <div className="border-b border-white/5 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-zinc-500">{label}</span>
        {context ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-label="Found in source" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-label="Not found in source" />}
      </div>
      <div className={`mt-1 text-sm ${present ? "text-zinc-200" : "text-zinc-500"}`}>{present ? String(value) : "Not extracted"}</div>
      <div className={`mt-2 rounded-md px-3 py-2 text-xs leading-5 ${context ? "bg-emerald-400/5 text-emerald-100" : "bg-amber-400/5 text-amber-100"}`}>
        {context ? <><span className="mr-2 text-[10px] font-bold uppercase tracking-wider text-emerald-400">Source line</span>{context}</> : "Not found in the original message slice — verify before trusting this field."}
      </div>
    </div>
  );
}

function status(row: ExtractionRow) {
  const flags = Array.isArray(row.validation_flags) ? row.validation_flags.length : row.validation_flags ? 1 : 0;
  if (row.needs_review || flags > 0) return { label: "Flagged for verification", tone: "amber", icon: AlertTriangle };
  return { label: "Saved", tone: "green", icon: CheckCircle2 };
}

function reviewReasons(row: ExtractionRow) {
  const rawFlags = Array.isArray(row.validation_flags)
    ? row.validation_flags.map(String)
    : row.validation_flags && typeof row.validation_flags === "object"
      ? Object.entries(row.validation_flags).map(([key, value]) => `${key}: ${String(value)}`)
      : [];
  const reasons: string[] = [];
  const flags = rawFlags.join(" ").toLowerCase();
  // A requirement is demand, not a building inventory row. A missing building
  // is therefore a valid state; locality/landmark preferences are the useful
  // evidence for the broker.
  if (!isRequirement(row) && (flags.includes("building") || !row.building_name)) reasons.push("Building was not resolved from the source");
  if (flags.includes("locality") || flags.includes("location") || !(row.micro_market || row.location_raw)) reasons.push("Location was not resolved from the source");
  if (!isRequirement(row) && row.price == null && row.price_per_sqft == null) reasons.push("Price is not present in the source");
  if (flags.includes("furnishing_without_source")) reasons.push("Furnishing was returned without matching source evidence");
  if (flags.includes("source") || flags.includes("mismatch")) reasons.push("One extracted field is not fully traceable to the source slice");
  if (String(row.summary_title || row.bhk || "").match(/jodi|combo|\+/i)) reasons.push("The multi-unit wording needs human interpretation");
  if (!reasons.length && rawFlags.length) reasons.push(...rawFlags.map((flag) => flag.replaceAll("_", " ")));
  if (!reasons.length && row.needs_review) reasons.push(isRequirement(row)
    ? "The requirement is saved with source evidence; review only the fields marked uncertain"
    : "The extraction was flagged for verification; no automatic reviewer is assigned");
  return [...new Set(reasons)].slice(0, 5);
}

function StatusBadge({ row }: { row: ExtractionRow }) {
  const current = status(row);
  const Icon = current.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold ${current.tone === "green" ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : "border-amber-400/20 bg-amber-400/10 text-amber-300"}`}>
      <Icon className="h-3 w-3" /> {current.label}
    </span>
  );
}

export default function ExtractionsPage() {
  const [rows, setRows] = useState<ExtractionRow[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [selected, setSelected] = useState<ExtractionRow | null>(null);
  const [evidence, setEvidence] = useState<RawEvidence | null>(null);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "listing" | "requirement">("all");
  const [assetFilter, setAssetFilter] = useState<"all" | "residential" | "commercial">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "saved" | "review">("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRows, nextProgress] = await Promise.all([
        fetchJSON<ExtractionRow[]>(`/parsed?limit=30&offset=${page * 30}&kind=${kindFilter === "all" ? "" : kindFilter}&asset_type=${assetFilter === "all" ? "" : assetFilter}`),
        fetchJSON<Progress>("/extraction/progress?hours=24"),
      ]);
      setRows(nextRows || []);
      setProgress(nextProgress);
      setError(null);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Could not load extraction activity");
    } finally {
      setLoading(false);
    }
  }, [assetFilter, kindFilter, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected?.raw_message_id) {
      setEvidence(null);
      return;
    }
    let active = true;
    setEvidence(null);
    fetchJSON<RawEvidence | RawEvidence[]>(`/raw?raw_id=${selected.raw_message_id}`)
      .then((value) => {
        if (active) setEvidence(Array.isArray(value) ? value[0] || null : value);
      })
      .catch(() => { if (active) setEvidence(null); });
    return () => { active = false; };
  }, [selected]);

  async function retrySelected() {
    if (!selected?.raw_message_id) return;
    setRetrying(true);
    setRetryMessage(null);
    try {
      await retryExtraction(selected.raw_message_id);
      setRetryMessage("Queued for the extraction worker. Refresh after it completes.");
    } catch (exc) {
      setRetryMessage(exc instanceof Error ? exc.message : "Could not queue retry");
    } finally {
      setRetrying(false);
    }
  }

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    let result = rows;
    if (statusFilter !== "all") {
      result = result.filter((row) => status(row).label === (statusFilter === "review" ? "Flagged for verification" : "Saved"));
    }
    if (!query) return result;
    return result.filter((row) => [
      row.building_name, row.micro_market, row.location_raw, row.broker_name,
      row.raw_group, row.intent, row.transaction_type,
    ].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [rows, search, statusFilter]);

  const reviewCount = rows.filter((row) => status(row).label === "Flagged for verification").length;
  const savedCount = rows.length - reviewCount;

  return (
    <div className="theme-extractions propai-page-stage mx-auto w-full max-w-7xl space-y-6 px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Link href="/admin" className="mt-1 rounded-lg p-1 text-zinc-500 hover:bg-white/5 hover:text-white" aria-label="Back to admin">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Your workspace · Live pipeline</div>
            <h1 className="mt-1 text-2xl font-bold text-white">Extraction Activity</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-400">
              See what the current AI extraction pipeline understood from WhatsApp and whether each result was saved safely.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-black hover:bg-emerald-300">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-400/20 bg-red-400/10 p-4 text-sm text-red-200">{error}</div>}
      {progress?.degraded && <div className="rounded-xl border border-amber-400/20 bg-amber-400/10 p-4 text-sm text-amber-200">{progress.warning}</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Recent results</div><div className="mt-2 text-2xl font-bold text-white">{rows.length}</div><div className="text-xs text-zinc-500">current source rows</div></div>
        <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-4"><div className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)]">Saved</div><div className="mt-2 text-2xl font-bold text-emerald-300">{savedCount}</div><div className="text-xs text-[var(--text-secondary)]">passed basic checks</div></div>
        <div className="rounded-xl border border-amber-400/15 bg-amber-400/5 p-4"><div className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)]">Flagged for verification</div><div className="mt-2 text-2xl font-bold text-amber-300">{reviewCount}</div><div className="text-xs text-[var(--text-secondary)]">validation or confidence issue · no reviewer assigned</div></div>
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Processed recently</div><div className="mt-2 text-2xl font-bold text-white">{progress?.recently_processed?.toLocaleString("en-IN") ?? "—"}</div><div className="text-xs text-zinc-500">raw messages in last {progress?.rate_window_hours ?? 24}h</div></div>
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Workspace scope</div><div className="mt-2 text-2xl font-bold text-white">Your workspace</div><div className="text-xs text-zinc-500">only your organization’s messages</div></div>
      </div>

      {progress && !progress.degraded && (
        <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-semibold text-white">Pipeline coverage</span><span className="text-zinc-400">{progress.progress_pct.toFixed(1)}% of your stored messages processed</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, Math.max(0, progress.progress_pct))}%` }} /></div>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-500"><span>{progress.processed.toLocaleString("en-IN")} processed</span><span>{(progress.eligible_pending ?? progress.pending).toLocaleString("en-IN")} eligible waiting</span>{Boolean(progress.suppressed) && <><span>{progress.suppressed?.toLocaleString("en-IN")} held by group consent</span><Link href="/connections" className="font-semibold text-emerald-300 hover:text-emerald-200 hover:underline">Manage group consent <ExternalLink className="inline h-3 w-3" /></Link></>}</div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">Held messages are not failed or human-review tasks. Select their WhatsApp groups explicitly to make them eligible for extraction.</p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div><h2 className="text-sm font-semibold text-white">Latest extraction results</h2><p className="mt-1 text-xs text-zinc-500">Only current typed listings and requirements are shown. Legacy knowledge candidates are excluded.</p></div>
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <select value={kindFilter} onChange={(event) => { setKindFilter(event.target.value as typeof kindFilter); setPage(0); }} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 outline-none"><option value="all">Listings + requirements</option><option value="listing">Listings only</option><option value="requirement">Requirements only</option></select>
            <select value={assetFilter} onChange={(event) => { setAssetFilter(event.target.value as typeof assetFilter); setPage(0); }} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 outline-none"><option value="all">All property types</option><option value="residential">Residential</option><option value="commercial">Commercial</option></select>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 outline-none"><option value="all">All statuses</option><option value="saved">Saved</option><option value="review">Flagged for verification</option></select>
            <div className="relative w-full sm:w-64"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search building, group, broker…" className="w-full rounded-lg border border-white/10 bg-zinc-800 py-2 pl-9 pr-8 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-400/50" />{search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"><X className="h-4 w-4" /></button>}</div>
          </div>
        </div>

        {loading && rows.length === 0 ? <div className="p-12 text-center text-sm text-zinc-500">Loading current extraction activity…</div> : filteredRows.length === 0 ? <div className="p-12 text-center text-sm text-zinc-500">No current extraction rows match this search.</div> : (
          <div className="divide-y divide-white/5">
            {filteredRows.map((row) => (
              <button key={`${row.source_schema}-${row.id}`} onClick={() => setSelected(row)} className="block w-full text-left transition-colors hover:bg-white/[0.03]">
                <div className="flex flex-wrap items-center gap-4 px-4 py-4">
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-white">{row.summary_title || [row.bhk, row.building_name || row.location_raw || row.micro_market].filter(Boolean).join(" · ") || "Property details extracted"}</span><StatusBadge row={row} /></div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500"><span>{formatDate(row.raw_timestamp || row.created_at)}</span><span>{row.raw_group || "WhatsApp group"}</span><span>{row.raw_message_id ? `Message #${row.raw_message_id}` : "No source message"}</span></div></div>
                  <div className="min-w-[145px] text-xs text-zinc-400"><div className="font-medium text-zinc-300">{extractionKind(row)} · {row.intent || row.transaction_type || "Unclassified"}</div><div className="mt-1">{row.asset_type || "property"} · {row.price_model === "budget" ? "budget" : formatPrice(row)}</div><div className="mt-1 text-emerald-300">{parserLabel(row)}</div>{extractionProvenance(row) && <div className="mt-1 max-w-[220px] truncate text-zinc-500" title={extractionProvenance(row) || undefined}>{extractionProvenance(row)}</div>}</div>
                  <div className="min-w-[175px] text-xs text-zinc-400"><div>{row.building_name || "Building not identified"}</div><div className="mt-1">{row.micro_market || row.location_raw || "Location not identified"}</div><div className="mt-1 text-zinc-500">{row.broker_name || row.broker_phone || "Broker not identified"}</div></div>
                  <div className="hidden min-w-[110px] text-right text-xs text-zinc-500 md:block"><div className="text-zinc-300">{confidence(row)}</div><div className="mt-1">{row.source_schema?.replace(/_/g, " ") || "typed source"}</div></div>
                  <ExternalLink className="h-4 w-4 text-zinc-600" />
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between border-t border-white/10 px-4 py-3"><span className="text-xs text-zinc-500">Page {page + 1} · {filteredRows.length} shown</span><div className="flex gap-2"><button disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40">Previous</button><button disabled={rows.length < 30 || loading} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40">Next</button></div></div>
      </div>

      {selected && <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setSelected(null)}><aside className="h-full w-full overflow-y-auto border-l border-white/10 bg-zinc-950 p-6 shadow-2xl lg:w-[min(100vw,1280px)] lg:max-w-none" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4 border-b border-white/10 pb-5"><div><div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Extraction detail</div><h2 className="mt-1 text-xl font-bold text-white">{selected.summary_title || "Extracted property"}</h2><div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge row={selected} /><span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[11px] font-semibold text-emerald-300">{parserLabel(selected)}</span></div></div><div className="flex items-center gap-2"><button onClick={() => void retrySelected()} disabled={retrying || !selected.raw_message_id} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 px-3 py-2 text-xs font-semibold text-amber-300 disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />{retrying ? "Queuing…" : "Retry extraction"}</button><button onClick={() => setSelected(null)} className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><X className="h-5 w-5" /></button></div></div>
        {retryMessage && <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">{retryMessage}</div>}
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]"><div><div className="grid grid-cols-2 gap-3 text-sm"><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">Type</div><div className="mt-1 text-zinc-200">{extractionKind(selected)}</div></div><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">Confidence</div><div className="mt-1 text-zinc-200">{confidence(selected)}</div></div><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">{isRequirement(selected) ? "Budget" : "Price"}</div><div className="mt-1 text-zinc-200">{formatPrice(selected)}</div></div><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">Area</div><div className="mt-1 text-zinc-200">{selected.area_min_sqft || selected.area_sqft ? `${(selected.area_min_sqft || selected.area_sqft)?.toLocaleString("en-IN")} sqft` : "Not present in source"}</div></div></div>
        <dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Building</dt><dd className="text-right text-zinc-200">{selected.building_name || (isRequirement(selected) ? "Optional — no building specified" : "Not resolved from source")}</dd></div><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Location</dt><dd className="text-right text-zinc-200">{selected.micro_market || selected.location_raw || "Not resolved from source"}</dd></div>{isRequirement(selected) && landmarkOptions(selected).length > 0 && <div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Nearby / alternatives</dt><dd className="max-w-[65%] text-right text-zinc-200">{landmarkOptions(selected).join(" · ")}</dd></div>}<div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Broker</dt><dd className="text-right text-zinc-200">{selected.broker_name || selected.broker_phone || "Not resolved from source"}</dd></div><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Furnishing</dt><dd className="text-right text-zinc-200">{selected.furnishing || "Not present in source"}</dd></div><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Source</dt><dd className="text-right text-zinc-200">{selected.source_schema?.replace(/_/g, " ") || "typed source"}</dd></div>{extractionProvenance(selected) && <div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Extraction provider</dt><dd className="max-w-[65%] text-right text-zinc-200">{extractionProvenance(selected)}</dd></div>}</dl>
        <section className="mt-7 border-t border-white/10 pt-5"><div className="text-sm font-semibold text-white">Field evidence</div><p className="mt-1 text-xs leading-5 text-zinc-500">Each extracted identity is checked against the original message. A green mark means a matching source line was found.</p><div className="mt-3 rounded-lg border border-white/10 bg-zinc-900/70 px-3">{!isRequirement(selected) && <EvidenceTrace label="Building" value={selected.building_name} message={evidence?.message} />}<EvidenceTrace label="Locality / preferred area" value={selected.micro_market || selected.location_raw} message={evidence?.message} /><EvidenceTrace label="Broker" value={selected.broker_name} message={evidence?.message} /></div></section>
        <section className="mt-7"><div className="flex items-center gap-2 text-sm font-semibold text-white"><Zap className="h-4 w-4 text-emerald-400" /> Why this is flagged</div><div className="mt-3 space-y-2 text-sm">{reviewReasons(selected).map((reason) => <div key={reason} className="flex gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /><span className="text-zinc-300">{reason}</span></div>)}</div></section></div>
        <div><section><div className="text-sm font-semibold text-white">Original WhatsApp evidence</div>{evidence ? <div className="mt-3 border border-white/10 bg-zinc-900/70 p-4"><div className="mb-3 text-xs text-zinc-500">{evidence.group_name || "WhatsApp"} · {formatDate(evidence.timestamp)}</div><p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">{evidence.message || "Message text unavailable"}</p></div> : <div className="mt-3 bg-zinc-900/70 p-4 text-sm text-zinc-500">Loading original message…</div>}</section><section className="mt-7 border-t border-white/10 pt-5"><div className="flex items-center gap-2 text-sm font-semibold text-white"><Clock3 className="h-4 w-4 text-sky-400" /> Processing record</div><p className="mt-3 text-sm leading-6 text-zinc-400">The message was written to the current typed extraction table. Review the source above before relying on unresolved fields.</p></section></div></div>
      </aside></div>}
    </div>
  );
}
