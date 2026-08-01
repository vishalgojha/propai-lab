"use client";

import { Building2, Layers3, MapPin, MessageSquare, Ruler, UserRound } from "lucide-react";

export interface ListingItem {
  listing_id?: number;
  raw_message_id?: number;
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
  first_seen_text?: string;
  group_count?: number;
  confidence?: number;
  fingerprint?: string;
  landmark_name?: string;
  floor?: number | string;
  wing?: string;
  flat_number?: string;
  property_type?: string;
  observation_count?: number;
  original_message?: string;
  match_reasons?: string[];
  sender_phone?: string;
  source?: string;
}

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

export default function ListingCard({
  item,
  onContactBroker,
  onHideBroker,
  onHideListing,
  onHideRequirement,
  contacting = false,
  compact = false,
}: {
  item: ListingItem;
  onContactBroker?: (listingId: number) => void;
  onHideBroker?: (phone: string, label: string) => void;
  onHideListing?: (item: ListingItem) => void;
  onHideRequirement?: (item: ListingItem) => void;
  contacting?: boolean;
  compact?: boolean;
}) {
  const intent = (item.intent || "").toUpperCase();
  const isWanted = intent === "REQUIREMENT" || intent === "BUY" || intent === "BUYER" || intent === "RENTAL_SEEKER";
  const isSale = intent === "SELL" || intent === "SALE";
  const isRent = intent === "RENT";

  const badgeLabel = isWanted ? "Wanted" : isRent ? "Rent" : "Sale";
  const cardClass = isWanted ? "card wanted" : "card sale";
  const badgeClass = isWanted ? "badge wanted" : "badge sale";

  const location = item.micro_market || item.location_label || item.landmark_name || "";
  const unit = [item.wing && `Wing ${item.wing}`, item.floor !== undefined && item.floor !== null && `Floor ${item.floor}`, item.flat_number && `Flat ${item.flat_number}`].filter(Boolean);
  const sourceSummary = item.group_count && item.group_count > 0
    ? `${item.group_count} WhatsApp ${item.group_count === 1 ? "group" : "groups"}`
    : "WhatsApp broker network";
  const hideLabel = isWanted ? "Hide requirement" : "Hide listing";
  const brokerPhone = (item.broker_phone || "").trim();
  const brokerLabel = item.broker_name || "Broker";

  return (
    <div className={`${cardClass} h-full overflow-hidden ${compact ? "text-[12px]" : ""}`}>
      <div className="card-top">
        <div>
          <span className={badgeClass}>{badgeLabel}</span>
          <div className="building flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-zinc-500" />{item.building_name || "Property from broker network"}</div>
          {location && <div className="locality flex items-center gap-1"><MapPin className="h-3 w-3" />{location}</div>}
        </div>
        {item.price_formatted && (
          <div className="price">
            {item.price_formatted}
            {item.area_sqft && <small>{item.area_sqft} sqft</small>}
          </div>
        )}
      </div>
      <div className="specs flex-wrap">
        {item.bhk && <span><b>{item.bhk}</b>{!item.bhk.toUpperCase().includes("BHK") ? " BHK" : ""}</span>}
        {item.area_sqft && <span className="inline-flex items-center gap-1"><Ruler className="h-3 w-3" /><b>{item.area_sqft}</b> sqft</span>}
        {item.furnishing && item.furnishing !== "None" && (
          <span><b>{item.furnishing}</b></span>
        )}
        {unit.map((detail) => <span key={detail} className="inline-flex items-center gap-1"><Layers3 className="h-3 w-3" />{detail}</span>)}
      </div>
      {(item.landmark_name || item.property_type || item.observation_count) && (
        <div className="mx-4 mb-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          {item.property_type && <span>{item.property_type}</span>}
          {item.landmark_name && <span>Near {item.landmark_name}</span>}
          {item.observation_count && item.observation_count > 1 && <span>{item.observation_count} verified mentions</span>}
        </div>
      )}
      <div className="card-bottom">
        <div>
          {item.broker_name && (
            <div className="broker inline-flex items-center gap-1"><UserRound className="h-3 w-3 text-zinc-500" /><b>{item.broker_name}</b></div>
          )}
          <div className="meta">
            {sourceSummary}{item.last_seen_text && ` · Active ${relativeTime(item.last_seen_text)}`}
          </div>
          {(onHideBroker || onHideListing || onHideRequirement) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {onHideListing && item.listing_id && (
                <button
                  type="button"
                  onClick={() => onHideListing(item)}
                  className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-300 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-200"
                >
                  {hideLabel}
                </button>
              )}
              {onHideRequirement && item.raw_message_id && isWanted && (
                <button
                  type="button"
                  onClick={() => onHideRequirement(item)}
                  className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-300 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-200"
                >
                  Hide requirement
                </button>
              )}
              {onHideBroker && brokerPhone && (
                <button
                  type="button"
                  onClick={() => onHideBroker(brokerPhone, brokerLabel)}
                  className="inline-flex items-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-300 hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-200"
                >
                  Hide broker
                </button>
              )}
            </div>
          )}
        </div>
        {item.listing_id && onContactBroker && (
          <button
            type="button"
            onClick={() => onContactBroker(item.listing_id!)}
            disabled={contacting}
            className="wa-btn disabled:cursor-wait disabled:opacity-60"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {contacting ? "Opening…" : "Contact broker"}
          </button>
        )}
      </div>
    </div>
  );
}
