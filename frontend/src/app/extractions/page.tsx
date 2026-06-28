"use client";

import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import PromoteModal from "@/components/PromoteModal";

const PAGE_SIZE = 50;

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

function whatsappLink(r: api.ListingRow): string {
  const phone = (r.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  if (phone.length !== 10) return "";
  const text = `Hi, I saw this ${r.bhk || "property"} listing${r.location_label ? ` in ${r.location_label}` : ""}. Is it still available?`;
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
}

export default function ExtractionsPage() {
  const [data, setData] = useState<api.ListingRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [promoteListing, setPromoteListing] = useState<api.ListingRow | null>(null);

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
      <div className="overflow-x-auto">
        <table className="data-table text-sm">
          <thead>
            <tr>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Listing</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Broker</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Type</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">BHK</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Price</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Area</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Location</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Counts</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Last seen</th>
              <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => {
              const waLink = whatsappLink(r);
              const listingTitle = [r.bhk, formatPrice(r.price, r.price_unit), r.location_label].filter(Boolean).join(" • ");
              const latestView = r.latest_raw_message_id ? `/observations/${r.latest_raw_message_id}` : "";
              return (
                <tr key={r.id} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    <div className="font-semibold text-[#e2e8f0]">{listingTitle || `Listing #${r.id}`}</div>
                    <div className="text-[10px] text-[#64748b]">{r.fingerprint.slice(0, 12)}</div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">
                    <div className="broker-cell">
                      <span>{r.broker_name || "-"}</span>
                      {waLink && <a href={waLink} target="_blank" rel="noreferrer" className="wa-icon" title="Message on WhatsApp" aria-label="Message on WhatsApp">WA</a>}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    {r.intent && <span className={`badge ${intentClass(r.intent)}`}>{r.intent}</span>}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.bhk}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{formatPrice(r.price, r.price_unit)}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{r.area_sqft ? `${r.area_sqft.toLocaleString()} sqft` : ""}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] min-w-[260px] max-w-[420px] break-words">
                    {r.location_label}
                    {r.latest_message && (
                      <div className="message-preview text-[10px] text-[#64748b] mt-1">{r.latest_message}</div>
                    )}
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
                      <button onClick={() => setPromoteListing(r)} className="text-xs font-semibold text-[#04100a] bg-[#3EE88A] hover:bg-[#2DC96E] rounded-lg px-2.5 py-1">Promote</button>
                      {latestView && <a href={latestView} className="text-xs font-semibold text-[#58a6ff] hover:underline">View latest</a>}
                      {r.location_label && <a href={`/search?q=${encodeURIComponent(r.location_label)}`} className="text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg px-2.5 py-1">Search</a>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
    </div>
  );
}
