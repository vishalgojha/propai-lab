"use client";

import { useEffect, useState } from "react";
import { Building2, Camera, Layers3, MapPin, MessageSquare, Ruler, UserRound, X } from "lucide-react";
import { fetchJSON } from "@/lib/api";
import { getAccessToken } from "@/lib/auth";
import { formatBuildingName } from "@/lib/listing-display";

export interface ListingItem {
  listing_id?: number;
  raw_message_id?: number;
  intent?: string;
  building_name?: string;
  building_address?: string;
  micro_market?: string;
  location_label?: string;
  street_name?: string;
  bhk?: string;
  price_formatted?: string;
  area_sqft?: number;
  furnishing?: string;
  broker_name?: string;
  broker_display_name?: string;
  broker_phone?: string;
  last_seen_text?: string;
  last_seen?: string;
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
  market_scope?: "workspace" | "shared";
  photo_count?: number;
  has_images?: boolean;
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

function normalizeWhatsappPhone(phone?: string | null) {
  const digits = String(phone || "").replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length >= 12 && digits.startsWith("91")) return digits.slice(-10);
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

function displayBhk(value?: string | number | null) {
  const text = String(value ?? "").trim().replace(/\s*bhk\b/i, "").trim();
  if (!text) return "";
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return text;
  return Number.isInteger(numeric) ? String(numeric) : String(numeric);
}

function displayBroker(item: ListingItem) {
  const resolved = String(item.broker_display_name || "").trim();
  if (resolved) return resolved;
  const raw = String(item.broker_name || "").trim();
  if (!raw || /@s\.whatsapp\.net$/i.test(raw) || /^\+?[\d\s()\-]+$/.test(raw)) return "Broker";
  return raw;
}

function buildPrefilledWhatsAppLink(item: ListingItem): string {
  const phone = normalizeWhatsappPhone(item.broker_phone);
  if (!phone) return "";

  const broker = displayBroker(item);
  const building = formatBuildingName(item.building_name);
  const locality = item.micro_market || item.location_label || item.landmark_name || "";
  const bhk = item.bhk || item.property_type || "";
  const price = item.price_formatted || "";
  const furnishing = item.furnishing || "";
  const baseLines = [
    `Hi ${broker},`,
    "",
  ];

  const isWanted = (item.intent || "").toUpperCase() === "REQUIREMENT"
    || (item.intent || "").toUpperCase() === "BUY"
    || (item.intent || "").toUpperCase() === "BUYER"
    || (item.intent || "").toUpperCase() === "RENTAL_SEEKER";

  if (isWanted) {
    baseLines.push(
      "I saw your requirement on PropAI.",
      "",
      `• ${building}`,
      locality ? `• ${locality}` : "",
      bhk ? `• ${bhk}` : "",
      price ? `• ${price}` : "",
      furnishing ? `• ${furnishing}` : "",
      "",
      "Is this still open?",
    );
  } else {
    baseLines.push(
      "I found your listing on PropAI.",
      "",
      `• ${building}`,
      locality ? `• ${locality}` : "",
      bhk ? `• ${bhk}` : "",
      price ? `• ${price}` : "",
      furnishing ? `• ${furnishing}` : "",
      "",
      "Is this still available?",
    );
  }

  baseLines.push("", "Sent via PropAI");
  const text = baseLines.join("\n").trim();
  return `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;
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
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [photos, setPhotos] = useState<Array<{ id: number; url: string; caption?: string }>>([]);
  const [photoError, setPhotoError] = useState("");
  const [loadingPhotos, setLoadingPhotos] = useState(false);
  const intent = (item.intent || "").toUpperCase();
  const isWanted = intent === "REQUIREMENT" || intent === "BUY" || intent === "BUYER" || intent === "RENTAL_SEEKER";
  const isSale = intent === "SELL" || intent === "SALE";
  const isRent = intent === "RENT";

  const badgeLabel = isWanted ? "Wanted" : isRent ? "Rent" : "Sale";
  const cardClass = isWanted ? "card wanted" : "card sale";
  const badgeClass = isWanted ? "badge wanted" : "badge sale";

  const location = item.building_address || item.street_name || item.micro_market || item.location_label || item.landmark_name || "";
  const unit = [item.wing && `Wing ${item.wing}`, item.floor !== undefined && item.floor !== null && `Floor ${item.floor}`, item.flat_number && `Flat ${item.flat_number}`].filter(Boolean);
  const sourceSummary = item.group_count && item.group_count > 0
    ? `${item.group_count} WhatsApp ${item.group_count === 1 ? "group" : "groups"}`
    : "WhatsApp broker network";
  const hideLabel = isWanted ? "Hide requirement" : "Hide listing";
  const brokerPhone = (item.broker_phone || "").trim();
  const brokerLabel = displayBroker(item);
  const waLink = buildPrefilledWhatsAppLink(item);

  useEffect(() => () => {
    photos.forEach((photo) => {
      if (photo.url.startsWith("blob:")) URL.revokeObjectURL(photo.url);
    });
  }, [photos]);

  async function openGallery() {
    if (!item.listing_id) return;
    setGalleryOpen(true);
    if (photos.length || loadingPhotos) return;
    setLoadingPhotos(true);
    setPhotoError("");
    try {
      const metadata = await fetchJSON<Array<{ id: number; url: string; caption?: string }>>(
        `/listings/${item.listing_id}/photos`,
      );
      const token = await getAccessToken();
      const resolved = await Promise.all((metadata || []).map(async (photo) => {
        const response = await fetch(photo.url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: "no-store",
        });
        if (!response.ok) throw new Error("photo request failed");
        return { ...photo, url: URL.createObjectURL(await response.blob()) };
      }));
      setPhotos(resolved);
    } catch {
      setPhotoError("Photos are temporarily unavailable.");
    } finally {
      setLoadingPhotos(false);
    }
  }

  return (
    <div className={`${cardClass} h-full overflow-hidden ${compact ? "text-[12px]" : ""}`}>
      <div className="card-top">
        <div>
          <span className={badgeClass}>{badgeLabel}</span>
          <span className="ml-1 inline-flex items-center rounded border border-emerald-400/20 bg-emerald-400/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
            {item.market_scope === "workspace" ? "Your WhatsApp group" : "PropAI shared network"}
          </span>
          <div className="building flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5 text-zinc-500" />{formatBuildingName(item.building_name)}</div>
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
        {item.bhk && <span><b>{displayBhk(item.bhk)}</b> BHK</span>}
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
          {(item.broker_display_name || item.broker_name || item.broker_phone) && (
            <div className="broker inline-flex items-center gap-1"><UserRound className="h-3 w-3 text-zinc-500" /><b>{brokerLabel}</b></div>
          )}
          {item.has_images && (
            <button type="button" onClick={openGallery} className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-300 hover:text-emerald-200">
              <Camera className="h-3 w-3" /> Images available ({item.photo_count})
            </button>
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
        <div className="flex flex-col gap-1.5">
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
          {waLink && (
            <a
              href={waLink}
              target="_blank"
              rel="noreferrer"
              className="wa-btn inline-flex items-center gap-1.5"
              onClick={(event) => event.stopPropagation()}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              WhatsApp
            </a>
          )}
        </div>
      </div>
      {galleryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setGalleryOpen(false)}>
          <div className="relative max-h-[90vh] w-full max-w-4xl rounded-xl border border-white/10 bg-zinc-950 p-4" onClick={(event) => event.stopPropagation()}>
            <button type="button" onClick={() => setGalleryOpen(false)} className="absolute right-3 top-3 rounded-full bg-black/70 p-2 text-zinc-200 hover:text-white" aria-label="Close gallery"><X className="h-4 w-4" /></button>
            <div className="mb-3 pr-10 text-sm font-semibold text-white">Property images</div>
            {loadingPhotos && <div className="py-16 text-center text-sm text-zinc-400">Loading images…</div>}
            {photoError && <div className="py-16 text-center text-sm text-amber-300">{photoError}</div>}
            {!loadingPhotos && !photoError && photos.length === 0 && <div className="py-16 text-center text-sm text-zinc-400">No images are attached yet.</div>}
            <div className="grid max-h-[78vh] grid-cols-1 gap-3 overflow-auto sm:grid-cols-2">
              {photos.map((photo) => <figure key={photo.id} className="overflow-hidden rounded-lg border border-white/10 bg-black"><img src={photo.url} alt={photo.caption || "Property photo"} className="h-auto max-h-[60vh] w-full object-contain" />{photo.caption && <figcaption className="p-2 text-xs text-zinc-400">{photo.caption}</figcaption>}</figure>)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
