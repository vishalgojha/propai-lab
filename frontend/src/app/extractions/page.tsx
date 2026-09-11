"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock3, ExternalLink, RefreshCw, Search, X, Zap } from "lucide-react";
import { fetchJSON, retryExtraction, updateParsedObservation } from "@/lib/api";

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
  commercial_use_type?: string | string[] | null;
  bhk?: string | number | null;
  price?: number | null;
  price_unit?: string | null;
  price_model?: string | null;
  price_per_sqft?: number | null;
  price_raw_text?: string | null;
  area_sqft?: number | null;
  carpet_area_sqft?: number | null;
  carpet_area_raw_text?: string | null;
  area_raw_text?: string | null;
  area_min_sqft?: number | null;
  area_max_sqft?: number | null;
  furnishing?: string | null;
  balcony_present?: boolean | null;
  floor_range?: string | null;
  budget_min?: number | null;
  budget_max?: number | null;
  bhk_options?: string | string[] | null;
  carpet_area_min_sqft?: number | null;
  carpet_area_max_sqft?: number | null;
  furnishing_preference?: string | null;
  car_parking_min?: number | null;
  terrace_area_sqft?: number | null;
  covered_terrace_area_sqft?: number | null;
  terrace_area_raw_text?: string | null;
  car_parking_count?: number | null;
  parking_type?: string | null;
  unstructured_facts?: Record<string, unknown> | string | null;
  broker_notes?: Array<{ category?: string; text?: string; source_text?: string }> | string | null;
  possession_status?: string | null;
  confidence?: number | string | null;
  extraction_confidence?: string | null;
  extraction_confidence_score?: number | null;
  needs_review?: boolean | null;
  validation_flags?: unknown[] | Record<string, unknown> | null;
  source_schema?: string | null;
  summary_title?: string | null;
  source_slice_text?: string | null;
  raw_payload?: { landmark_options?: unknown; [key: string]: unknown } | string | null;
  ai_extraction?: Record<string, unknown> | string | null;
  preflight?: {
    document_type?: string | null;
    pattern_id?: string | null;
    block_count?: number | null;
    signals?: string[] | null;
    origin?: string | null;
  } | null;
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

type CorrectionField = {
  key: string;
  label: string;
  numeric?: boolean;
  placeholder?: string;
};

function formatPrice(row: ExtractionRow) {
  const value = row.price ?? row.price_per_sqft;
  if (value == null) return row.price_raw_text?.trim() || "Price not found";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Price needs review";
  const formatted = amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return row.price_per_sqft != null && row.price == null ? `₹${formatted}/sqft` : `₹${formatted}`;
}

function readableValue(value?: string | number | null) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const readable = String(value ?? "").replaceAll("_", " ").replaceAll("-", " ").trim();
  return /^(?:not\s+specified|unspecified|unknown|null|none|n\/a|na)$/i.test(readable) ? "" : readable;
}

function propertyIntelligence(row: ExtractionRow): Array<{ section: string; label: string; value: string; source?: string }> {
  const ai = parseObject(row.ai_extraction);
  const facts = parseObject(ai.property_intelligence || parseObject(row.unstructured_facts).property_intelligence);
  const out: Array<{ section: string; label: string; value: string; source?: string }> = [];
  for (const [section, rawEntries] of Object.entries(facts)) {
    if (!Array.isArray(rawEntries)) continue;
    for (const raw of rawEntries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as Record<string, unknown>;
      const value = String(entry.value ?? entry.target ?? entry.text ?? "").trim();
      if (!value) continue;
      out.push({
        section: section.replaceAll("_", " "),
        label: String(entry.label ?? entry.type ?? "fact").replaceAll("_", " "),
        value,
        source: typeof entry.source_text === "string" ? entry.source_text : undefined,
      });
    }
  }
  return out;
}

function extractionTitle(row: ExtractionRow) {
  if (row.summary_title?.trim()) return row.summary_title.trim();
  const readableBhk = readableValue(row.bhk);
  const bhk = readableBhk ? `${readableBhk}${/\bbhk\b/i.test(String(row.bhk)) ? "" : " BHK"}` : "Property";
  const furnishing = readableValue(row.furnishing);
  const furnishingLabel = furnishing ? furnishing.charAt(0).toUpperCase() + furnishing.slice(1) : "";
  const descriptor = [furnishing && furnishing.toLowerCase() !== "unfurnished" ? furnishingLabel : null, bhk].filter(Boolean).join(" ");
  const transaction = /rent|lease/i.test(`${row.intent || ""} ${row.transaction_type || ""}`) ? "for rent"
    : /sale|sell|buy/i.test(`${row.intent || ""} ${row.transaction_type || ""}`) ? "for sale" : "";
  const place = row.building_name && (row.micro_market || row.location_raw)
    ? `${row.building_name} in ${row.micro_market || row.location_raw}`
    : row.building_name || row.micro_market || row.location_raw;
  return [descriptor, transaction, place ? `at ${place}` : null].filter(Boolean).join(" ") || "Property details extracted";
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceSlice(row: ExtractionRow): string {
  if (row.source_slice_text?.trim()) return row.source_slice_text.trim();
  const payload = parsePayload(row.raw_payload);
  return String(payload.source_slice_text || payload.slice_text || payload.full_text || "").trim();
}

function validationFlags(row: ExtractionRow): string[] {
  if (Array.isArray(row.validation_flags)) return row.validation_flags.map(String).filter(Boolean);
  if (row.validation_flags && typeof row.validation_flags === "object") {
    return Object.entries(row.validation_flags).map(([key, value]) => `${key}: ${String(value)}`);
  }
  return [];
}

function isRequirement(row: ExtractionRow) {
  return row.message_type === "requirement" || row.source_schema?.endsWith("_requirements");
}

function landmarkOptions(row: ExtractionRow): string[] {
  const payload = typeof row.raw_payload === "string" ? (() => { try { return JSON.parse(row.raw_payload as string); } catch { return null; } })() : row.raw_payload;
  return Array.isArray(payload?.landmark_options) ? payload.landmark_options.map(String).filter(Boolean).slice(0, 8) : [];
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function carpetAreaSource(row: ExtractionRow): string | null {
  return row.carpet_area_raw_text || (row.area_raw_text && /carpet/i.test(row.area_raw_text) ? row.area_raw_text : null);
}

function additionalFacts(row: ExtractionRow): Array<{ label: string; value: string; source?: string }> {
  const facts = parseObject(row.unstructured_facts);
  const out: Array<{ label: string; value: string; source?: string }> = [];
  const carpetArea = carpetAreaSource(row);
  for (const [key, raw] of Object.entries(facts)) {
    if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) continue;
    const value = Array.isArray(raw) ? raw.map(String).join(", ") : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
    out.push({ label: key.replaceAll("_", " "), value });
  }
  if (row.terrace_area_raw_text && !out.some((fact) => fact.label.toLowerCase() === "terrace")) {
    out.push({ label: "terrace", value: row.terrace_area_raw_text, source: row.terrace_area_raw_text });
  }
  if (carpetArea && !out.some((fact) => fact.label.toLowerCase().includes("carpet area"))) {
    out.push({ label: "carpet area", value: carpetArea, source: carpetArea });
  }
  if (row.car_parking_count != null && !out.some((fact) => fact.label.toLowerCase().includes("parking"))) {
    out.push({ label: "parking", value: `${row.car_parking_count}${row.parking_type ? ` ${row.parking_type}` : ""} car park${row.car_parking_count === 1 ? "" : "s"}` });
  }
  let notes = row.broker_notes;
  if (typeof notes === "string") {
    try { notes = JSON.parse(notes); } catch { notes = []; }
  }
  if (Array.isArray(notes)) {
    for (const note of notes) {
      if (!note?.text) continue;
      out.push({ label: note.category ? note.category.replaceAll("_", " ") : "broker note", value: note.text, source: note.source_text });
    }
  }
  return out;
}

function extractionKind(row: ExtractionRow) {
  return isRequirement(row) ? "Requirement" : "Listing";
}

function isCommercial(row: ExtractionRow) {
  return row.asset_type === "commercial" || row.source_schema?.startsWith("commercial_");
}

function correctionFields(row: ExtractionRow): CorrectionField[] {
  if (isRequirement(row)) {
    return [
      { key: "bhk_options", label: "BHK options", placeholder: "2, 3" },
      { key: "carpet_area_min_sqft", label: "Min carpet area (sqft)", numeric: true },
      { key: "carpet_area_max_sqft", label: "Max carpet area (sqft)", numeric: true },
      { key: "budget_min", label: "Min budget", numeric: true },
      { key: "budget_max", label: "Max budget", numeric: true },
      { key: "furnishing_preference", label: "Furnishing" },
      { key: "car_parking_min", label: "Min car parks", numeric: true },
    ];
  }
  const fields: CorrectionField[] = [
    ...(!isCommercial(row) ? [{ key: "bhk", label: "BHK" }] : [{ key: "commercial_use_type", label: "Commercial use" }]),
    { key: "area_sqft", label: isCommercial(row) ? "Carpet area (sqft)" : "Carpet area (sqft)", numeric: true },
    ...(!isCommercial(row) ? [{ key: "balcony_present", label: "Balcony" }] : []),
    { key: "price", label: row.transaction_type === "rent" ? "Monthly rent" : "Price", numeric: true },
    { key: "furnishing", label: isCommercial(row) ? "Fit-out" : "Furnishing" },
    { key: "car_parking_count", label: "Car parks", numeric: true },
    { key: "parking_type", label: "Parking type" },
    { key: "floor_range", label: "Floor" },
  ];
  return fields;
}

function structuredFields(row: ExtractionRow): Array<{ label: string; value: string }> {
  const fields = correctionFields(row).map((field) => {
    const value = row[field.key as keyof ExtractionRow];
    return { label: field.label, value: readableValue(value as string | number | null) || "Not extracted" };
  });
  const trace = preflightTrace(row);
  if (trace) {
    fields.push(
      { label: "Preflight document type", value: trace.documentType },
      { label: "Preflight boundary pattern", value: trace.pattern },
      { label: "Preflight detected blocks", value: trace.blockCount },
      { label: "Preflight signals", value: trace.signals.length ? trace.signals.join(", ") : "None" },
      { label: "Preflight evidence origin", value: trace.origin },
    );
  }
  return fields;
}

function parserLabel(row: ExtractionRow) {
  const value = typeof row.ai_extraction === "string"
    ? (() => { try { return JSON.parse(row.ai_extraction as string); } catch { return null; } })()
    : row.ai_extraction;
  if (value && typeof value === "object" && Object.keys(value).length > 0) return "AI parsed";
  if (row.source_schema?.endsWith("_listings") || row.source_schema?.endsWith("_requirements")) return "Typed extraction";
  return "Legacy / provenance unavailable";
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

function preflightTrace(row: ExtractionRow) {
  const value = row.preflight;
  if (!value || typeof value !== "object") return null;
  return {
    documentType: readableValue(value.document_type) || "Unknown",
    pattern: readableValue(value.pattern_id) || "No boundary pattern",
    blockCount: Number.isFinite(Number(value.block_count)) ? String(value.block_count) : "0",
    signals: Array.isArray(value.signals) ? value.signals.map(String).filter(Boolean) : [],
    origin: readableValue(value.origin) || "Not recorded",
  };
}

function formatDate(value?: string | null) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function confidence(row: ExtractionRow) {
  const raw = row.extraction_confidence_score ?? row.confidence;
  if (raw !== null && raw !== undefined && raw !== "") {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return `${Math.round(numeric * 100)}% confidence`;
  }
  return row.extraction_confidence ? `${row.extraction_confidence} confidence` : "Not scored";
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
    <div className="extraction-evidence-row border-b border-white/5 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="extraction-muted text-xs font-semibold uppercase tracking-[0.08em]">{label}</span>
        {context ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" aria-label="Found in source" /> : <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" aria-label="Not found in source" />}
      </div>
      <div className={`extraction-value mt-1 text-sm ${present ? "" : "extraction-muted"}`}>{present ? String(value) : "Not extracted"}</div>
      <div className={`extraction-source-line mt-2 rounded-md border px-3 py-2 text-xs leading-5 ${context ? "is-found" : "is-missing"}`}>
        {context ? <><span className="mr-2 text-[10px] font-bold uppercase tracking-wider">Source line</span>{context}</> : "Not found in the original message — the source is attached above."}
      </div>
    </div>
  );
}

function status(row: ExtractionRow) {
  // Quality metadata remains attached to the row and is shown as evidence,
  // but the UI must distinguish persistence from extraction quality.
  const score = Number(row.extraction_confidence_score ?? row.confidence);
  if (row.needs_review || (Number.isFinite(score) && score < 0.7)) {
    return { label: "Quality flag", tone: "amber", icon: AlertTriangle };
  }
  return { label: "Saved", tone: "green", icon: CheckCircle2 };
}

function extractionNotes(row: ExtractionRow) {
  const rawFlags = Array.isArray(row.validation_flags)
    ? row.validation_flags.map(String)
    : row.validation_flags && typeof row.validation_flags === "object"
      ? Object.entries(row.validation_flags).map(([key, value]) => `${key}: ${String(value)}`)
      : [];
  const reasons: string[] = [];
  const flags = rawFlags.join(" ").toLowerCase();
  const hasBuilding = Boolean(String(row.building_name || "").trim());
  const hasLocation = Boolean(String(row.micro_market || row.location_raw || "").trim());
  const hasBrokerIdentity = Boolean(String(row.broker_name || row.broker_phone || "").trim());
  // A requirement is demand, not a building inventory row. A missing building
  // is therefore a valid state; locality/landmark preferences are the useful
  // evidence for the broker.
  if (!isRequirement(row) && !hasBuilding) reasons.push("Building was not resolved from the source");
  if (!hasLocation) reasons.push("Location was not resolved from the source");
  if (!isRequirement(row) && row.price == null && row.price_per_sqft == null) reasons.push("Price is not present in the source");
  if (flags.includes("furnishing_without_source")) reasons.push("Furnishing was returned without matching source evidence");
  if ((flags.includes("source") || flags.includes("mismatch")) && (!hasBuilding || !hasLocation || !hasBrokerIdentity)) {
    reasons.push("One identity field is not fully traceable to the source slice");
  }
  if (String(row.summary_title || row.bhk || "").match(/jodi|combo|\+/i)) reasons.push("The multi-unit wording is ambiguous");
  if (!reasons.length && rawFlags.length) reasons.push(...rawFlags.map((flag) => flag.replaceAll("_", " ")));
  if (!reasons.length && row.needs_review) reasons.push("Some fields could not be matched confidently to the source message");
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
  const [searchInput, setSearchInput] = useState("");
  const loadSequence = useRef(0);
  const [kindFilter, setKindFilter] = useState<"all" | "listing" | "requirement">("all");
  const [assetFilter, setAssetFilter] = useState<"all" | "residential" | "commercial">("all");
  const [qualityFilter, setQualityFilter] = useState<"all" | "review" | "clean">("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    try {
      const [nextRows, nextProgress] = await Promise.all([
        fetchJSON<ExtractionRow[]>(`/parsed?limit=30&offset=${page * 30}&kind=${kindFilter === "all" ? "" : kindFilter}&asset_type=${assetFilter === "all" ? "" : assetFilter}&search=${encodeURIComponent(search.trim())}`),
        fetchJSON<Progress>("/extraction/progress?hours=24"),
      ]);
      // Search and pagination can produce overlapping requests. Never let an
      // older response replace the rows for the query currently on screen.
      if (sequence !== loadSequence.current) return;
      setRows(nextRows || []);
      setProgress(nextProgress);
      setError(null);
    } catch (exc) {
      if (sequence !== loadSequence.current) return;
      setError(exc instanceof Error ? exc.message : "Could not load extraction activity");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [assetFilter, kindFilter, page, search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const normalized = searchInput.trim();
    if (normalized === search) return;
    const timer = window.setTimeout(() => {
      setPage(0);
      setSearch(normalized);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, searchInput]);

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

  function openExtraction(row: ExtractionRow) {
    setEditing(false);
    setActionMessage(null);
    const nextDraft: Record<string, string> = {
      summary_title: row.summary_title || extractionTitle(row),
      building_name: row.building_name || "",
      micro_market: row.micro_market || row.location_raw || "",
      transaction_type: row.transaction_type || "",
    };
    for (const field of correctionFields(row)) {
      const value = row[field.key as keyof ExtractionRow];
      nextDraft[field.key] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    }
    setDraft(nextDraft);
    setSelected(row);
  }

  async function handleRetry() {
    if (!selected?.raw_message_id) return;
    setRetrying(true);
    setActionMessage(null);
    try {
      await retryExtraction(selected.raw_message_id);
      setActionMessage("Queued for extraction. Refresh after the worker processes this message.");
    } catch (exc) {
      setActionMessage(exc instanceof Error ? exc.message : "Could not queue this message for retry.");
    } finally {
      setRetrying(false);
    }
  }

  async function handleSaveCorrection() {
    if (!selected) return;
    setSaving(true);
    setActionMessage(null);
    try {
      const updates = {
        summary_title: draft.summary_title.trim() || null,
        building_name: draft.building_name.trim() || null,
        micro_market: draft.micro_market.trim() || null,
        transaction_type: draft.transaction_type === "rent" || draft.transaction_type === "sale" ? draft.transaction_type : null,
      };
      const numericFields = new Set(correctionFields(selected).filter((field) => field.numeric).map((field) => field.key));
      const fieldUpdates: Record<string, unknown> = { ...updates };
      for (const field of correctionFields(selected)) {
        const value = draft[field.key]?.trim() || "";
        fieldUpdates[field.key] = value === "" ? null : numericFields.has(field.key) ? Number(value) : value;
      }
      await updateParsedObservation(selected.id, selected.source_schema || null, fieldUpdates);
      const updated = { ...selected, ...fieldUpdates } as ExtractionRow;
      setSelected(updated);
      setRows((current) => current.map((row) => row.id === selected.id && row.source_schema === selected.source_schema ? updated : row));
      setEditing(false);
      setActionMessage("Correction saved. The original WhatsApp evidence remains unchanged.");
    } catch (exc) {
      setActionMessage(exc instanceof Error ? exc.message : "Could not save this correction.");
    } finally {
      setSaving(false);
    }
  }

  const filteredRows = useMemo(() => rows.filter((row) => {
  const needsAttention = status(row).label === "Quality flag" || extractionNotes(row).length > 0;
    return qualityFilter === "all" || (qualityFilter === "review" ? needsAttention : !needsAttention);
  }), [qualityFilter, rows]);

  const savedCount = rows.length;

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
      {progress?.degraded && <div className="extraction-progress-warning rounded-xl border p-4 text-sm">{progress.warning}</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Recent results</div><div className="mt-2 text-2xl font-bold text-white">{rows.length}</div><div className="text-xs text-zinc-500">current source rows</div></div>
        <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/5 p-4"><div className="text-[11px] uppercase tracking-wider text-[var(--text-secondary)]">Saved rows</div><div className="mt-2 text-2xl font-bold text-emerald-300">{savedCount}</div><div className="text-xs text-[var(--text-secondary)]">stored extraction records</div></div>
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Quality notes</div><div className="mt-2 text-2xl font-bold text-white">{rows.filter((row) => extractionNotes(row).length > 0).length}</div><div className="text-xs text-zinc-500">shown with each source record</div></div>
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Marked processed recently</div><div className="mt-2 text-2xl font-bold text-white">{progress?.recently_processed?.toLocaleString("en-IN") ?? "—"}</div><div className="text-xs text-zinc-500">raw messages in last {progress?.rate_window_hours ?? 24}h</div></div>
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 p-4"><div className="text-[11px] uppercase tracking-wider text-zinc-500">Workspace scope</div><div className="mt-2 text-2xl font-bold text-white">Your workspace</div><div className="text-xs text-zinc-500">only your organization’s messages</div></div>
      </div>

      {progress && !progress.degraded && (
        <div className="rounded-xl border border-white/10 bg-zinc-900/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-semibold text-white">Message processing status</span><span className="text-zinc-400">{progress.progress_pct.toFixed(1)}% of stored messages marked processed</span></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-emerald-400" style={{ width: `${Math.min(100, Math.max(0, progress.progress_pct))}%` }} /></div>
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-500"><span>{progress.processed.toLocaleString("en-IN")} marked processed</span><span>{(progress.eligible_pending ?? progress.pending).toLocaleString("en-IN")} waiting and eligible</span>{Boolean(progress.suppressed) && <><span>{progress.suppressed?.toLocaleString("en-IN")} held by group consent</span><Link href="/whatsapp?tab=numbers" className="font-semibold text-emerald-300 hover:text-emerald-200 hover:underline">Manage group consent <ExternalLink className="inline h-3 w-3" /></Link></>}</div>
          <p className="mt-3 text-xs leading-5 text-zinc-500">These are raw-message ledger counts, not a quality or publishing score. A processed message can still produce a review-needed result. Held messages are not failed; select their WhatsApp groups to make them eligible for extraction.</p>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-white/10 bg-zinc-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div><h2 className="text-sm font-semibold text-white">Latest extraction results</h2><p className="mt-1 text-xs text-zinc-500">Only current typed listings and requirements are shown. Legacy knowledge candidates are excluded.</p></div>
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <select value={kindFilter} onChange={(event) => { setKindFilter(event.target.value as typeof kindFilter); setPage(0); }} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 outline-none"><option value="all">Listings + requirements</option><option value="listing">Listings only</option><option value="requirement">Requirements only</option></select>
            <select value={assetFilter} onChange={(event) => { setAssetFilter(event.target.value as typeof assetFilter); setPage(0); }} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 outline-none"><option value="all">All property types</option><option value="residential">Residential</option><option value="commercial">Commercial</option></select>
            <select value={qualityFilter} onChange={(event) => setQualityFilter(event.target.value as typeof qualityFilter)} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs text-zinc-300 outline-none"><option value="all">All quality states</option><option value="review">Quality flags</option><option value="clean">Auto-passed</option></select>
            <div className="relative w-full sm:w-64"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" /><input aria-label="Search extraction results" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search building, group, broker…" className="w-full rounded-lg border border-white/10 bg-zinc-800 py-2 pl-9 pr-8 text-xs text-white outline-none placeholder:text-zinc-500 focus:border-emerald-400/50" />{searchInput && <button type="button" aria-label="Clear extraction search" onClick={() => { setSearchInput(""); setSearch(""); setPage(0); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white"><X className="h-4 w-4" /></button>}</div>
          </div>
        </div>

        {loading && rows.length === 0 ? <div className="p-12 text-center text-sm text-zinc-500">Loading current extraction activity…</div> : filteredRows.length === 0 ? <div className="p-12 text-center text-sm text-zinc-500">No current extraction rows match this search.</div> : (
          <div className="divide-y divide-white/5">
            {filteredRows.map((row) => (
              <button key={`${row.source_schema}-${row.id}`} onClick={() => openExtraction(row)} className="block w-full text-left transition-colors hover:bg-white/[0.03]">
                <div className="flex flex-wrap items-center gap-4 px-4 py-4">
                  <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-white">{extractionTitle(row)}</span><StatusBadge row={row} /></div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-zinc-500"><span>{formatDate(row.raw_timestamp || row.created_at)}</span><span>{row.raw_group || "WhatsApp group"}</span><span>{row.raw_message_id ? `Message #${row.raw_message_id}` : "No source message"}</span></div></div>
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

      {selected && <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={() => setSelected(null)}><aside className="h-full w-full overflow-y-auto border-l border-white/10 bg-zinc-950 p-6 shadow-2xl lg:w-[min(100vw,1280px)] lg:max-w-none" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4 border-b border-white/10 pb-5"><div><div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Extraction trace</div><h2 className="mt-1 text-xl font-bold text-white">{extractionTitle(selected)}</h2><div className="mt-2 flex flex-wrap items-center gap-2"><StatusBadge row={selected} /><span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[11px] font-semibold text-emerald-300">{parserLabel(selected)}</span>{extractionProvenance(selected) && <span className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-zinc-400">{extractionProvenance(selected)}</span>}</div></div><div className="flex items-center gap-2"><button type="button" onClick={() => void handleRetry()} disabled={retrying} className="rounded-lg border border-amber-400/30 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-400/10 disabled:opacity-50">{retrying ? "Queuing…" : "Retry extraction"}</button><button onClick={() => setSelected(null)} className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><X className="h-5 w-5" /></button></div></div>
        {actionMessage && <div className="mt-4 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">{actionMessage}</div>}
        <div className="flex items-center justify-between gap-3"><div><div className="text-sm font-semibold text-white">Structured result</div><p className="mt-1 text-xs text-zinc-500">What was saved, separate from the original evidence.</p></div><button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 hover:border-emerald-400/40 hover:text-white">{editing ? "Cancel edit" : "Correct fields"}</button></div>
        <section className="mt-4 rounded-lg border border-white/10 bg-zinc-900/50 p-4"><div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Relevant extracted fields</div><div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">{structuredFields(selected).map((field) => <div key={field.label} className="border-b border-white/5 pb-2"><div className="text-xs text-zinc-500">{field.label}</div><div className={`mt-1 text-sm ${field.value === "Not extracted" ? "text-zinc-500" : "text-zinc-200"}`}>{field.value}</div></div>)}</div></section>
        {editing && <div className="mt-4 grid gap-3 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.04] p-4 sm:grid-cols-2"><label className="sm:col-span-2"><span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Public title</span><input value={draft.summary_title || ""} onChange={(event) => setDraft((value) => ({ ...value, summary_title: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60" /></label><label><span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Building</span><input value={draft.building_name || ""} onChange={(event) => setDraft((value) => ({ ...value, building_name: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60" /></label><label><span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Locality</span><input value={draft.micro_market || ""} onChange={(event) => setDraft((value) => ({ ...value, micro_market: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60" /></label><label><span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Transaction</span><select value={draft.transaction_type || ""} onChange={(event) => setDraft((value) => ({ ...value, transaction_type: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none focus:border-emerald-400/60"><option value="">Unchanged</option><option value="rent">Rent</option><option value="sale">Sale</option></select></label>{correctionFields(selected).map((field) => <label key={field.key}><span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{field.label}</span><input type={field.numeric ? "number" : "text"} step={field.numeric ? "any" : undefined} placeholder={field.placeholder} value={draft[field.key] || ""} onChange={(event) => setDraft((value) => ({ ...value, [field.key]: event.target.value }))} className="mt-1 w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-emerald-400/60" /></label>)}<div className="flex items-end justify-end sm:col-span-2"><button type="button" onClick={() => void handleSaveCorrection()} disabled={saving} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-bold text-black hover:bg-emerald-300 disabled:opacity-50">{saving ? "Saving…" : "Save correction"}</button></div></div>}
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]"><div><div className="grid grid-cols-2 gap-3 text-sm"><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">Type</div><div className="mt-1 text-zinc-200">{extractionKind(selected)}</div></div><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">Confidence</div><div className="mt-1 text-zinc-200">{confidence(selected)}</div></div><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">{isRequirement(selected) ? "Budget" : "Price"}</div><div className="mt-1 text-zinc-200">{formatPrice(selected)}</div></div><div className="bg-zinc-900/70 p-3"><div className="text-xs text-zinc-500">Area</div><div className="mt-1 text-zinc-200">{selected.area_min_sqft || selected.area_sqft ? `${(selected.area_min_sqft || selected.area_sqft)?.toLocaleString("en-IN")} sqft${selected.carpet_area_sqft || carpetAreaSource(selected) ? " carpet" : ""}` : "Not present in source"}</div>{carpetAreaSource(selected) && <div className="mt-1 text-xs text-emerald-200">Carpet area: {carpetAreaSource(selected)}</div>}{(selected.terrace_area_sqft || selected.terrace_area_raw_text) && <div className="mt-1 text-xs text-emerald-200">Carpet terrace: {selected.terrace_area_sqft ? `${selected.terrace_area_sqft.toLocaleString("en-IN")} sqft` : selected.terrace_area_raw_text}</div>}</div></div>
        <dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Building</dt><dd className="text-right text-zinc-200">{selected.building_name || (isRequirement(selected) ? "Optional — no building specified" : "Not resolved from source")}</dd></div><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Location</dt><dd className="text-right text-zinc-200">{selected.micro_market || selected.location_raw || "Not resolved from source"}</dd></div>{isRequirement(selected) && landmarkOptions(selected).length > 0 && <div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Nearby / alternatives</dt><dd className="max-w-[65%] text-right text-zinc-200">{landmarkOptions(selected).join(" · ")}</dd></div>}<div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Broker</dt><dd className="text-right text-zinc-200">{selected.broker_name || selected.broker_phone || "Not resolved from source"}</dd></div><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Furnishing</dt><dd className="text-right text-zinc-200">{selected.furnishing || "Not present in source"}</dd></div><div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Source</dt><dd className="text-right text-zinc-200">{selected.source_schema?.replace(/_/g, " ") || "typed source"}</dd></div>{extractionProvenance(selected) && <div className="flex justify-between gap-4 border-b border-white/5 pb-2"><dt className="text-zinc-500">Extraction provider</dt><dd className="max-w-[65%] text-right text-zinc-200">{extractionProvenance(selected)}</dd></div>}</dl>
        <section className="mt-7 border-t border-white/10 pt-5"><div className="text-sm font-semibold text-white">Field evidence</div><p className="mt-1 text-xs leading-5 text-zinc-500">Each extracted identity is checked against the original message. A green mark means a matching source line was found.</p><div className="mt-3 rounded-lg border border-white/10 bg-zinc-900/70 px-3">{!isRequirement(selected) && <EvidenceTrace label="Building" value={selected.building_name} message={evidence?.message} />}<EvidenceTrace label="Locality / preferred area" value={selected.micro_market || selected.location_raw} message={evidence?.message} />{selected.broker_name && <EvidenceTrace label="Broker name" value={selected.broker_name} message={evidence?.message} />}<EvidenceTrace label="Broker phone" value={selected.broker_phone} message={evidence?.message} /></div></section>
        {additionalFacts(selected).length > 0 && <section className="mt-7 border-t border-white/10 pt-5"><div className="text-sm font-semibold text-white">Additional property details</div><p className="mt-1 text-xs leading-5 text-zinc-500">Explicit details from this listing that do not yet have a dedicated field.</p><div className="mt-3 space-y-2 rounded-lg border border-emerald-400/15 bg-emerald-400/[0.04] p-3">{additionalFacts(selected).map((fact, index) => <div key={`${fact.label}-${index}`} className="border-b border-white/5 pb-2 last:border-b-0 last:pb-0"><div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-200/80">{fact.label}</div><div className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">{fact.value}</div>{fact.source && fact.source !== fact.value && <div className="mt-1 text-xs text-zinc-500">Source: {fact.source}</div>}</div>)}</div></section>}
        {propertyIntelligence(selected).length > 0 && <section className="mt-7 border-t border-white/10 pt-5"><div className="text-sm font-semibold text-white">Property intelligence</div><p className="mt-1 text-xs leading-5 text-zinc-500">Source-grounded context retained for future search, matching, and analysis.</p><div className="mt-3 grid gap-2 sm:grid-cols-2">{propertyIntelligence(selected).map((fact, index) => <div key={`${fact.section}-${fact.label}-${index}`} className="rounded-lg border border-sky-400/15 bg-sky-400/[0.04] p-3"><div className="text-[10px] font-semibold uppercase tracking-wider text-sky-200/80">{fact.section} · {fact.label}</div><div className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">{fact.value}</div>{fact.source && <div className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-zinc-500">Source: {fact.source}</div>}</div>)}</div></section>}
        <section className="mt-7"><div className="flex items-center gap-2 text-sm font-semibold text-white"><Zap className="h-4 w-4 text-emerald-400" /> Extraction decision</div><p className="mt-1 text-xs leading-5 text-zinc-400">Safe rows can pass automatically. This trace shows why this row was flagged so you can correct or retry only the exceptions.</p><div className="mt-3 space-y-2 text-sm">{extractionNotes(selected).length ? extractionNotes(selected).map((reason) => <div key={reason} className="flex gap-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" /><span className="text-zinc-300">{reason}</span></div>) : <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-xs text-emerald-200">No quality exception was recorded for this row.</div>}</div>{validationFlags(selected).length > 0 && <div className="mt-4 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3"><div className="text-[10px] font-semibold uppercase tracking-wider text-amber-300">Validation flags</div><ul className="mt-2 space-y-1 text-xs leading-5 text-amber-100">{validationFlags(selected).map((flag, index) => <li key={`${flag}-${index}`}>• {flag.replaceAll("_", " ")}</li>)}</ul></div>}</section></div>
        <div><section><div className="text-sm font-semibold text-white">Source evidence</div><p className="mt-1 text-xs text-zinc-500">The full WhatsApp message is retained; the source slice is the text used for this row.</p>{sourceSlice(selected) && <div className="mt-3 rounded-lg border border-[var(--accent)]/40 bg-[var(--surface-raised)] p-4 shadow-sm"><div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">Selected source slice · exact broker text</div><p className="mt-2 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-[var(--text-primary)] selection:bg-[var(--accent)]/25">{sourceSlice(selected)}</p></div>}{evidence ? <div className="mt-3 border border-white/10 bg-zinc-900/70 p-4"><div className="mb-3 text-xs text-zinc-500">{evidence.group_name || "WhatsApp"} · {formatDate(evidence.timestamp)} · Message #{selected.raw_message_id}</div><p className="whitespace-pre-wrap text-sm leading-6 text-zinc-200">{evidence.message || "Message text unavailable"}</p></div> : <div className="mt-3 bg-zinc-900/70 p-4 text-sm text-zinc-500">Loading original message…</div>}</section><section className="mt-7 border-t border-white/10 pt-5"><div className="flex items-center gap-2 text-sm font-semibold text-white"><Clock3 className="h-4 w-4 text-sky-400" /> Processing trace</div><dl className="mt-3 space-y-2 text-xs"><div className="flex justify-between gap-4"><dt className="text-zinc-500">Parser</dt><dd className="text-right text-zinc-200">{parserLabel(selected)}</dd></div><div className="flex justify-between gap-4"><dt className="text-zinc-500">Provider / model</dt><dd className="max-w-[65%] text-right text-zinc-200">{extractionProvenance(selected) || "Not recorded"}</dd></div><div className="flex justify-between gap-4"><dt className="text-zinc-500">Saved at</dt><dd className="text-right text-zinc-200">{formatDate(selected.created_at)}</dd></div><div className="flex justify-between gap-4"><dt className="text-zinc-500">Source schema</dt><dd className="max-w-[65%] break-all text-right text-zinc-200">{selected.source_schema || "Not recorded"}</dd></div></dl>{Object.keys(parsePayload(selected.ai_extraction)).length > 0 && <details className="mt-4 rounded-lg border border-white/10 bg-zinc-900/70"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-zinc-300">View raw AI response</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-white/10 px-3 py-3 text-[11px] leading-5 text-zinc-400">{JSON.stringify(parsePayload(selected.ai_extraction), null, 2)}</pre></details>}</section></div></div>
      </aside></div>}
    </div>
  );
}
