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
  const isWanted = intent === "REQUIREMENT";
  const isSale = intent === "SELL" || intent === "SALE";
  const isRent = intent === "RENT";

  const badgeLabel = isWanted ? "Wanted" : isRent ? "Rent" : "Sale";
  const cardClass = isWanted ? "card wanted" : "card sale";
  const badgeClass = isWanted ? "badge wanted" : "badge sale";

  const location = item.micro_market || item.location_label || item.landmark_name || "";
  const waLink = item.broker_phone
    ? `https://wa.me/${item.broker_phone.replace(/[^0-9]/g, "")}?text=${encodeURIComponent(`Hi, I saw your listing on PropAI. Is this still available?`)}`
    : "";

  return (
    <div className={cardClass}>
      <div className="card-top">
        <div>
          <span className={badgeClass}>{badgeLabel}</span>
          <div className="building">{item.building_name || "Unknown Building"}</div>
          {location && <div className="locality">{location}</div>}
        </div>
        {item.price_formatted && (
          <div className="price">
            {item.price_formatted}
            {item.area_sqft && <small>{item.area_sqft} sqft</small>}
          </div>
        )}
      </div>
      <div className="specs">
        {item.bhk && <span><b>{item.bhk}</b> BHK</span>}
        {item.area_sqft && <span><b>{item.area_sqft}</b> sqft</span>}
        {item.furnishing && item.furnishing !== "None" && (
          <span><b>{item.furnishing}</b></span>
        )}
      </div>
      <div className="card-bottom">
        <div>
          {item.broker_name && (
            <div className="broker"><b>{item.broker_name}</b></div>
          )}
          <div className="meta">
            {item.group_count && item.group_count > 0 && `${item.group_count} grp · `}
            {item.last_seen_text && relativeTime(item.last_seen_text)}
          </div>
        </div>
        {waLink && (
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            className="wa-btn"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            WhatsApp
          </a>
        )}
      </div>
    </div>
  );
}