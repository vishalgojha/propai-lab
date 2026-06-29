"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";

interface SourceDrawerProps {
  listingId?: number;
  parsedId?: number;
  listing?: any;
  parsed?: any;
  title?: string;
  onClose: () => void;
}

interface SourceObservation {
  raw_message_id: number;
  raw_message: string;
  raw_group: string;
  raw_group_name: string;
  raw_sender: string;
  raw_sender_phone: string;
  raw_timestamp: string;
  broker_name: string;
  broker_phone: string;
  intent: string;
  principal: string;
  bhk: string;
  price: number;
  price_unit: string;
  area_sqft: number;
  furnishing: string;
  location_raw: string;
  building_name: string;
  landmark_name: string;
  micro_market: string;
  confidence: number;
}

function formatPrice(value?: number | null, unit?: string | null) {
  if (!value) return "";
  if (value >= 10000000) {
    return `₹${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (value >= 100000) {
    return `₹${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L`;
  }
  return `₹${value.toLocaleString("en-IN")}`;
}

function formatTimestamp(ts: string): string {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true,
    });
  } catch {
    return ts;
  }
}

function formatRelativeTime(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return "yesterday";
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch {
    return "";
  }
}

function intentLabel(intent?: string | null) {
  if (!intent) return "—";
  const map: Record<string, string> = {
    SELL: "Listing (Sale)", SELLER: "Listing (Sale)",
    BUY: "Requirement (Buy)", BUYER: "Requirement (Buyer)",
    RENT: "Listing (Rent)", RENTAL: "Listing (Rent)",
    RENTAL_SEEKER: "Requirement (Tenant)",
    COMMERCIAL: "Commercial", COMMERCIAL_SALE: "Commercial (Sale)", COMMERCIAL_RENTAL: "Commercial (Rent)",
  };
  return map[intent] || intent;
}

function confidenceColor(c: number): string {
  if (c >= 0.9) return "text-[#00ff88]";
  if (c >= 0.7) return "text-[#f0c000]";
  return "text-[#ff6b35]";
}

export default function SourceDrawer({ listingId, parsedId, listing, parsed, title, onClose }: SourceDrawerProps) {
  const [sources, setSources] = useState<SourceObservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Use listing/parsed props directly for the summary (they have richer data)
  const summary = listing || parsed;

  useEffect(() => {
    setLoading(true);
    setError("");

    const fetchSources = async () => {
      try {
        if (listingId) {
          const data = await api.getListingSources(listingId);
          setSources(data);
        } else if (parsedId) {
          const data = await api.getParsedSources(parsedId);
          setSources(data);
        }
      } catch (e: any) {
        setError(e?.message || "Failed to load sources");
      } finally {
        setLoading(false);
      }
    };

    fetchSources();
  }, [listingId, parsedId]);

  // Get unique groups from sources
  const uniqueGroups = [...new Set(sources.map((s) => s.raw_group_name || s.raw_group).filter(Boolean))];
  const firstSeen = sources.length > 0 ? sources[sources.length - 1].raw_timestamp : null;
  const lastSeen = sources.length > 0 ? sources[0].raw_timestamp : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60">
      <div className="absolute right-0 top-0 h-full w-full max-w-2xl overflow-y-auto bg-[#0a0f14] border-l border-[rgba(255,255,255,0.1)] shadow-2xl">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[rgba(255,255,255,0.1)] bg-[#0a0f14] px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-[#e2e8f0]">{title || "Source Evidence"}</h2>
            <div className="text-xs text-[#64748b]">
              {loading ? "Loading..." : `${sources.length} observation${sources.length !== 1 ? "s" : ""} across ${uniqueGroups.length} group${uniqueGroups.length !== 1 ? "s" : ""}`}
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-[rgba(255,255,255,0.15)] px-3 py-1.5 text-sm text-[#64748b] hover:bg-[#111820]">Close</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Listing/Requirement Summary */}
          {summary && (
            <Section title="Parsed Summary">
              <div className="grid grid-cols-2 gap-3 text-sm">
                {summary.bhk && <Field label="BHK" value={summary.bhk} />}
                {summary.intent && <Field label="Type" value={intentLabel(summary.intent)} />}
                {summary.price && <Field label="Price" value={`${formatPrice(summary.price, summary.price_unit)}${summary.intent === "RENT" ? "/month" : ""}`} />}
                {summary.area_sqft && <Field label="Area" value={`${summary.area_sqft.toLocaleString()} sqft`} />}
                {summary.furnishing && <Field label="Furnishing" value={summary.furnishing} />}
                {(summary.location_label || summary.location_raw) && <Field label="Location" value={summary.location_label || summary.location_raw} />}
                {summary.building_name && <Field label="Building" value={summary.building_name} />}
                {summary.micro_market && <Field label="Market" value={summary.micro_market} />}
                {summary.landmark_name && <Field label="Landmark" value={summary.landmark_name} />}
              </div>
              {summary.confidence != null && (
                <div className="mt-3 flex items-center gap-2">
                  <span className="text-[10px] text-[#64748b] uppercase tracking-wider">Confidence</span>
                  <span className={`text-sm font-bold ${confidenceColor(summary.confidence)}`}>
                    {Math.round(summary.confidence * 100)}%
                  </span>
                </div>
              )}
            </Section>
          )}

          {/* Evidence Summary */}
          {!loading && sources.length > 0 && (
            <Section title="Evidence Summary">
              <div className="grid grid-cols-3 gap-3 text-sm">
                <div className="bg-[#111820] rounded-lg p-3">
                  <div className="text-[10px] text-[#64748b] uppercase">Total Sightings</div>
                  <div className="text-lg font-bold text-[#e2e8f0]">{sources.length}</div>
                </div>
                <div className="bg-[#111820] rounded-lg p-3">
                  <div className="text-[10px] text-[#64748b] uppercase">Groups</div>
                  <div className="text-lg font-bold text-[#e2e8f0]">{uniqueGroups.length}</div>
                </div>
                <div className="bg-[#111820] rounded-lg p-3">
                  <div className="text-[10px] text-[#64748b] uppercase">First Seen</div>
                  <div className="text-sm font-bold text-[#e2e8f0]">{formatRelativeTime(firstSeen || "")}</div>
                </div>
              </div>
              {uniqueGroups.length > 0 && (
                <div className="mt-3">
                  <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Seen in groups</div>
                  <div className="flex flex-wrap gap-1.5">
                    {uniqueGroups.map((g) => (
                      <span key={g} className="text-[10px] bg-[#111820] border border-[rgba(255,255,255,0.08)] rounded px-2 py-0.5 text-[#94a3b8]">{g}</span>
                    ))}
                  </div>
                </div>
              )}
            </Section>
          )}

          {/* Loading */}
          {loading && (
            <div className="text-center py-8 text-[#64748b]">Loading source observations...</div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-[rgba(255,80,80,0.3)] bg-[rgba(255,80,80,0.08)] p-4 text-sm">
              <div className="font-semibold text-[#ff6b6b] mb-1">Unable to load sources</div>
              <div className="text-[#94a3b8]">{error}</div>
              <button onClick={() => window.location.reload()} className="mt-2 text-xs text-[#58a6ff] hover:underline">Retry</button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && sources.length === 0 && (
            <div className="text-center py-8">
              <div className="text-4xl mb-2">🔍</div>
              <div className="text-sm text-[#64748b]">No source observations found.</div>
              <div className="text-xs text-[#475569] mt-1">This listing exists but its source messages were not retained.</div>
            </div>
          )}

          {/* Source Observations */}
          {!loading && sources.length > 0 && (
            <Section title="Original WhatsApp Posts">
              <div className="space-y-4">
                {sources.map((source, idx) => (
                  <div key={idx} className="rounded-lg border border-[rgba(255,255,255,0.06)] bg-[#0d1117] p-4">
                    {/* Observation header */}
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] bg-[#58a6ff]/20 text-[#58a6ff] rounded px-1.5 py-0.5 font-mono">#{source.raw_message_id}</span>
                        <span className="text-xs text-[#e2e8f0] font-semibold">{source.raw_group_name || source.raw_group}</span>
                      </div>
                      <span className="text-[10px] text-[#64748b]">{formatTimestamp(source.raw_timestamp)}</span>
                    </div>

                    {/* Sender info */}
                    <div className="flex items-center gap-3 mb-3 text-[11px]">
                      <span className="text-[#94a3b8]">
                        <span className="text-[#64748b]">From:</span>{" "}
                        <span className="font-semibold text-[#e2e8f0]">{source.raw_sender || "Unknown"}</span>
                      </span>
                      {source.raw_sender_phone && (
                        <span className="text-[#64748b] font-mono">{source.raw_sender_phone}</span>
                      )}
                    </div>

                    {/* Raw message */}
                    <div className="bg-[#111820] rounded-lg p-3 mb-3">
                      <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-1">Raw Message</div>
                      <div className="text-sm text-[#e2e8f0] whitespace-pre-wrap break-words font-mono leading-relaxed">
                        {source.raw_message}
                      </div>
                    </div>

                    {/* Parser extraction */}
                    <div className="bg-[#111820] rounded-lg p-3">
                      <div className="text-[10px] text-[#64748b] uppercase tracking-wider mb-2">Parser Extraction</div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                        {source.intent && <ExtractionField label="Type" value={intentLabel(source.intent)} />}
                        {source.bhk && <ExtractionField label="BHK" value={source.bhk} />}
                        {source.price && <ExtractionField label="Price" value={formatPrice(source.price, source.price_unit)} />}
                        {source.area_sqft && <ExtractionField label="Area" value={`${source.area_sqft} sqft`} />}
                        {source.furnishing && <ExtractionField label="Furnishing" value={source.furnishing} />}
                        {source.building_name && <ExtractionField label="Building" value={source.building_name} />}
                        {source.location_raw && <ExtractionField label="Locality" value={source.location_raw} />}
                        {source.micro_market && <ExtractionField label="Market" value={source.micro_market} />}
                        {source.broker_name && <ExtractionField label="Contact" value={source.broker_name} />}
                        {source.confidence != null && <ExtractionField label="Confidence" value={`${Math.round(source.confidence * 100)}%`} />}
                      </div>
                    </div>

                    {/* View full observation link */}
                    <div className="mt-3">
                      <a
                        href={`/observations/${source.raw_message_id}`}
                        className="text-[11px] text-[#58a6ff] hover:underline"
                      >
                        View full observation →
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[11px] font-bold text-[#64748b] uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px] text-[#64748b] uppercase">{label}</span>
      <div className="text-sm text-[#e2e8f0] font-semibold">{value}</div>
    </div>
  );
}

function ExtractionField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[#00ff88]">✓</span>
      <span className="text-[#64748b]">{label}:</span>
      <span className="text-[#e2e8f0] font-semibold">{value}</span>
    </div>
  );
}
