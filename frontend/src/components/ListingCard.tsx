"use client";

import { MessageSquare, Clock, Building2 } from "lucide-react";

export interface ListingItem {
  intent?: string;
  building_name?: string;
  micro_market?: string;
  location_label?: string;
  bhk?: string;
  price_formatted?: string;
  area_sqft?: number;
  furnishing?: string;
  broker_name?: string;
  broker_phone?: string;
  last_seen_text?: string;
  group_count?: number;
  confidence?: number;
  fingerprint?: string;
  landmark_name?: string;
}

const INTENT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  SELL: { bg: "bg-emerald-900/40", text: "text-emerald-300", label: "SALE" },
  RENT: { bg: "bg-blue-900/40", text: "text-blue-300", label: "RENT" },
  REQUIREMENT: { bg: "bg-amber-900/40", text: "text-amber-300", label: "WANTED" },
};

function relativeTime(text: string): string {
  if (!text) return "";
  try {
    const d = new Date(text);
    if (isNaN(d.getTime())) return text;
    const now = Date.now();
    const diffMs = now - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  } catch {
    return text;
  }
}

export default function ListingCard({ item }: { item: ListingItem }) {
  const intent = (item.intent || "").toUpperCase();
  const style = INTENT_STYLES[intent] || { bg: "bg-zinc-800", text: "text-zinc-300", label: intent || "LISTING" };

  const location = item.micro_market || item.location_label || item.landmark_name || "";
  const waLink = item.broker_phone
    ? `https://wa.me/${item.broker_phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(`Hi, I saw your listing on PropAI. Is this still available?`)}`
    : "";

  return (
    <div className="bg-zinc-900/80 border border-white/10 rounded-lg p-3 hover:border-white/20 transition-colors">
      {/* Header: intent badge + building */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${style.bg} ${style.text} shrink-0`}>
            {style.label}
          </span>
          {item.bhk && (
            <span className="text-[10px] font-semibold text-white bg-white/10 px-1.5 py-0.5 rounded shrink-0">
              {item.bhk}
            </span>
          )}
        </div>
        {item.confidence != null && item.confidence > 0 && (
          <span className="text-[9px] text-zinc-500 shrink-0">{item.confidence}%</span>
        )}
      </div>

      {/* Building + location */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <Building2 className="w-3 h-3 text-zinc-500 shrink-0" />
        <span className="text-xs font-semibold text-white truncate">
          {item.building_name || "Unknown Building"}
        </span>
      </div>
      {location && (
        <div className="text-[11px] text-zinc-400 mb-2 truncate">{location}</div>
      )}

      {/* Specs row */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-2 text-[11px]">
        {item.price_formatted && (
          <span className="text-white font-semibold">{item.price_formatted}</span>
        )}
        {item.area_sqft && (
          <span className="text-zinc-400">{item.area_sqft} sqft</span>
        )}
        {item.furnishing && item.furnishing !== "None" && (
          <span className="text-zinc-500">{item.furnishing}</span>
        )}
      </div>

      {/* Footer: broker + meta */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-white/5">
        <div className="flex items-center gap-2 min-w-0">
          {item.broker_name && (
            <span className="text-[11px] text-zinc-300 truncate">{item.broker_name}</span>
          )}
          {item.broker_phone && (
            <span className="text-[10px] text-zinc-500">{item.broker_phone}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {item.group_count != null && item.group_count > 0 && (
            <span className="text-[9px] text-zinc-500">{item.group_count} grp</span>
          )}
          {item.last_seen_text && (
            <span className="flex items-center gap-0.5 text-[9px] text-zinc-500">
              <Clock className="w-2.5 h-2.5" />
              {relativeTime(item.last_seen_text)}
            </span>
          )}
        </div>
      </div>

      {/* WhatsApp CTA */}
      {waLink && (
        <a
          href={waLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center justify-center gap-1.5 w-full py-1.5 rounded-md bg-[#25D366]/10 border border-[#25D366]/20 text-[#25D366] text-[11px] font-semibold hover:bg-[#25D366]/20 transition-colors"
        >
          <MessageSquare className="w-3 h-3" />
          Message on WhatsApp
        </a>
      )}
    </div>
  );
}
