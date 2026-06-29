"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import PromoteModal from "@/components/PromoteModal";
import SourceDrawer from "@/components/SourceDrawer";

const PAGE_SIZE = 50;
const COMMERCIAL_INTENTS = new Set(["COMMERCIAL", "COMMERCIAL_SALE", "COMMERCIAL_RENTAL"]);

function formatPrice(value?: number | null, unit?: string | null) {
  if (!value) return "";
  if (unit === "K" || value >= 1000 && value < 100000) {
    if (value >= 10000000) {
      return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
    }
    if (value >= 100000) {
      return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
    }
    if (value >= 1000) {
      return `${(value / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} K`;
    }
  }
  if (value >= 10000000) {
    return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (value >= 100000) {
    return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
  }
  return value.toLocaleString("en-IN");
}

function intentClass(intent: string) {
  return ({
    SELL: "badge-green",
    SELLER: "badge-green",
    BUY: "badge-purple",
    BUYER: "badge-purple",
    REQUIREMENT: "badge-purple",
    RENT: "badge-yellow",
    RENTAL: "badge-yellow",
    RENTAL_SEEKER: "badge-yellow",
    COMMERCIAL: "badge-orange",
    COMMERCIAL_SALE: "badge-orange",
    COMMERCIAL_RENTAL: "badge-orange",
    "PRE-LAUNCH": "badge-red",
} as Record<string, string>)[intent] || "badge-blue";
}

function isCommercialIntent(intent?: string | null) {
  return !!intent && COMMERCIAL_INTENTS.has(intent);
}

function listingLabel(r: api.ListingRow) {
  const pieces = [formatPrice(r.price, r.price_unit), r.location_label].filter(Boolean);
  if (!isCommercialIntent(r.intent) && r.bhk) {
    pieces.unshift(r.bhk);
  }
  return pieces.join(" • ");
}

function isValidPhone(phone: string): boolean {
  const digits = (phone || "").replace(/[^0-9]/g, "").slice(-10);
  return digits.length === 10;
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

function whatsappLink(r: api.ListingRow): string {
  const phone = (r.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (phone.length !== 10) return "";

  const isCommercial = isCommercialIntent(r.intent);
  const propertyType = isCommercial ? "commercial space" : (r.bhk || "property");
  const location = r.location_label || r.micro_market || "";
  const price = formatPrice(r.price, r.price_unit);

  // Build property summary line
  const parts = [r.bhk, location, price].filter(Boolean);
  const propertySummary = parts.join(" \u2022 ");

  // Provenance context
  const sourceLine = r.latest_group
    ? `Found via PropAI \u2014 shared in "${r.latest_group}"`
    : "Found via PropAI";
  const seenLine = r.observation_count > 1
    ? `Seen in ${r.observation_count} posts across ${r.group_count} group${r.group_count !== 1 ? "s" : ""}`
    : "";
  const timeLine = r.last_seen
    ? `Latest: ${formatRelativeTime(r.last_seen)}`
    : "";

  // Compose message
  const lines = [
    `Hi,`,
    ``,
    `I came across your ${propertyType} listing through PropAI.`,
    ``,
    propertySummary && `Property: ${propertySummary}`,
    seenLine,
    timeLine,
    ``,
    `Is it still available?`,
  ];

  return `https://wa.me/91${phone}?text=${encodeURIComponent(lines.filter(Boolean).join("\n"))}`;
}

function phoneDisplay(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (digits.length !== 10) return phone || "";
  return `+91 ${digits.slice(0, 2)} ${digits.slice(2, 7)} ${digits.slice(7)}`;
}

function splitListings(rows: api.ListingRow[]) {
  return {
    commercial: rows.filter((r) => isCommercialIntent(r.intent)),
    residential: rows.filter((r) => !isCommercialIntent(r.intent)),
  };
}

function ListingTable({
  rows,
  commercial = false,
  onPromote,
  onSources,
}: {
  rows: api.ListingRow[];
  commercial?: boolean;
  onPromote: (row: api.ListingRow) => void;
  onSources: (row: api.ListingRow) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="data-table text-sm">
        <thead>
          <tr>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Listing</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Broker</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Type</th>
            {!commercial && (
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">BHK</th>
            )}
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Price</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Area</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Location</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Counts</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Last seen</th>
            <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const waLink = whatsappLink(r);
            return (
              <tr key={r.id} className="hover:bg-[#0d1117]">
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                  <div className="font-semibold text-[#e2e8f0]">{listingLabel(r) || `Listing #${r.id}`}</div>
                  <div className="text-[10px] text-[#64748b]">{r.fingerprint.slice(0, 12)}</div>
                </td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">
                  <div className="broker-cell">
                    <span>{r.broker_name || (r.broker_phone ? phoneDisplay(r.broker_phone) : "-")}</span>
                    {waLink && <a href={waLink} target="_blank" rel="noreferrer" className="wa-icon" title="Message on WhatsApp" aria-label="Message on WhatsApp">WA</a>}
                  </div>
                  {r.broker_phone && isValidPhone(r.broker_phone) && (
                    <div className="text-[10px] text-[#64748b] font-mono mt-0.5">{phoneDisplay(r.broker_phone)}</div>
                  )}
                </td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                  {r.intent && <span className={`badge ${intentClass(r.intent)}`}>{r.intent}</span>}
                </td>
                {!commercial && (
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.bhk}</td>
                )}
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{formatPrice(r.price, r.price_unit)}</td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.area_sqft ? `${r.area_sqft.toLocaleString()} sqft` : ""}</td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[260px] max-w-[420px] break-words">
                  {r.location_label}
                </td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                  <div className="flex flex-wrap gap-2">
                    <span className="badge badge-blue">{r.observation_count} posts</span>
                    <span className="badge badge-purple">{r.group_count} groups</span>
                  </div>
                </td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-[#64748b]">
                  {r.latest_timestamp || r.last_seen}
                </td>
                <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[180px]">
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => onPromote(r)} className="text-xs font-semibold text-[#04100a] bg-[#3EE88A] hover:bg-[#2DC96E] rounded-lg px-2.5 py-1">Promote</button>
                    <button onClick={() => onSources(r)} className="text-xs font-semibold text-white bg-[#58a6ff] hover:bg-[#4090e0] rounded-lg px-2.5 py-1">Sources</button>
                    {r.location_label && <a href={`/search?q=${encodeURIComponent(r.location_label)}`} className="text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg px-2.5 py-1">Search</a>}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function ExtractionsPage() {
  const [data, setData] = useState<api.ListingRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [promoteListing, setPromoteListing] = useState<api.ListingRow | null>(null);
  const [sourceListing, setSourceListing] = useState<api.ListingRow | null>(null);
  const { commercial, residential } = splitListings(data);

  useEffect(() => {
    api.getListings(PAGE_SIZE, offset).then(setData);
  }, [offset]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-bold text-[#e2e8f0]">Market Listings</h2>
        <div className="text-sm text-[#64748b] mt-1">Listings currently circulating across broker WhatsApp groups.</div>
      </div>
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        <button onClick={() => api.getListings(PAGE_SIZE, offset).then(setData)} className="px-3 py-1.5 bg-[#3EE88A] text-[#04100a] rounded-lg text-sm font-bold">Refresh</button>
      </div>
      <div className="space-y-8">
        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-base font-bold text-[#e2e8f0]">Residential Listings</h3>
              <div className="text-xs text-[#64748b]">Homes and requirements with BHK structure.</div>
            </div>
            <div className="text-xs text-[#64748b]">{residential.length} rows</div>
          </div>
          <ListingTable rows={residential} onPromote={setPromoteListing} onSources={setSourceListing} />
        </section>

        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <h3 className="text-base font-bold text-[#e2e8f0]">Commercial Listings</h3>
              <div className="text-xs text-[#64748b]">Offices, shops, showrooms, warehouses and other commercial spaces.</div>
            </div>
            <div className="text-xs text-[#64748b]">{commercial.length} rows</div>
          </div>
          <ListingTable rows={commercial} commercial onPromote={setPromoteListing} onSources={setSourceListing} />
        </section>
      </div>
      <div className="flex gap-2 items-center mt-3">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="px-3 py-1 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm disabled:opacity-40">Prev</button>
        <span className="text-sm text-[#64748b]">{data.length > 0 ? `${offset + 1}–${offset + data.length}` : "0"}</span>
        <button disabled={data.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)} className="px-3 py-1 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-sm disabled:opacity-40">Next</button>
      </div>
      {promoteListing && (
        <PromoteModal
          observationId={promoteListing.representative_raw_message_id || promoteListing.latest_raw_message_id}
          listing={promoteListing}
          onClose={() => setPromoteListing(null)}
        />
      )}
      {sourceListing && (
        <SourceDrawer
          listingId={sourceListing.id}
          listing={sourceListing}
          title={`Source Evidence: ${sourceListing.location_label || `Listing #${sourceListing.id}`}`}
          onClose={() => setSourceListing(null)}
        />
      )}
    </div>
  );
}
