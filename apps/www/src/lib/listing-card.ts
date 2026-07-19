import { slugify } from "./supabase";

export type ListingCardFields = {
  id: number;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  area_sqft: number | null;
  furnishing: string | null;
  intent: string | null;
  asset_type: string | null;
  property_type: string | null;
  micro_market: string | null;
  building_name: string | null;
  landmark_name?: string | null;
  location_label?: string | null;
  floor_description?: string | null;
  view?: string | null;
  title?: string | null;
  representative_raw_message_id?: number | null;
  latest_raw_message_id?: number | null;
  broker_name: string | null;
  broker_phone: string | null;
  last_seen: string | null;
};

// Structured spec entries so callers can render an icon per spec (bed count,
// area, furnishing, floor...) instead of one flat "3 BHK · 850 sqft" string.
export type ListingSpecItem = {
  kind: "bhk" | "area" | "furnishing" | "floor" | "view" | "type";
  label: string;
};

export type ListingCardViewModel = {
  title: string;
  locality: string | null;
  localitySlug: string | null;
  isBuilding: boolean;
  priceLabel: string;
  specRow: string;
  specItems: ListingSpecItem[];
    statusLabel: string;
    statusTone: "available" | "unconfirmed";
    updatedLabel: string;
    freshnessLabel: string;
    freshnessBadge: string | null;
    assetTypeLabel: string | null;
  waLink: string | null;
  href: string | null;
  brokerName: string | null;
};

function normalizeUnit(value: string | null): string | null {
  if (!value) return null;
  const u = value.trim().toLowerCase();
  if (u === "cr" || u === "crore" || u === "crores") return "cr";
  if (u === "lac" || u === "lakh" || u === "lakhs") return "lac";
  if (u === "k" || u === "thousand") return "k";
  if (u === "abs") return "abs";
  return null;
}

function intentValue(intent: string | null): "rent" | "sale" | "commercial" | null {
  const i = (intent || "").toLowerCase();
  if (i === "rent" || i === "rental" || i === "lease") return "rent";
  if (i === "sell" || i === "sale" || i === "resale" || i === "buy" || i === "purchase") return "sale";
  if (i === "commercial") return "commercial";
  return null;
}

// Human-readable residential/commercial label for a listing card. Prefers the
// parsed asset_type (residential | commercial); falls back to the intent when
// asset_type is missing so historical rows still get a sensible badge.
export function assetTypeLabel(
  assetType: string | null,
  intent: string | null,
): string | null {
  const a = (assetType || "").trim().toLowerCase();
  if (a === "commercial") return "Commercial";
  if (a === "residential") return "Residential";
  const i = intentValue(intent);
  if (i === "commercial") return "Commercial";
  if (i === "rent" || i === "sale") return "Residential";
  return null;
}

// Renders an explicit, buyer-readable price with a unit. Never a bare number.
//
// Ingestion stores prices inconsistently by unit:
//   - "cr" / "k": the number is ABSOLUTE rupees with a leftover unit
//     (e.g. 26600000 with unit "cr" => ₹2.66 Cr; 85000 "k" rent => ₹85,000/mo).
//   - "lac": the number is already in lakh-scale (e.g. 110000 => ₹110,000 Lakh).
//   - "abs": absolute rupees.
// We normalise each to a readable, grouped amount in the appropriate unit.
export function formatCardPrice(
  price: number | null,
  priceUnit: string | null,
  intent: string | null,
): string {
  const unit = normalizeUnit(priceUnit);
  const intentKind = intentValue(intent);
  const perMonth = intentKind === "rent";

  if (price == null) return "Price on request";

  const grouped = (n: number) => Math.round(n).toLocaleString("en-IN");

  if (perMonth) {
    // Rentals are quoted per month. Stored numbers use the natural unit:
    // "cr" = crores/month, "lac" = lakhs/month, "k" = thousands/month,
    // "abs" = absolute rupees/month. Multiply up to rupees.
    let abs = price;
    if (unit === "cr") abs = price * 1_00_00_000;
    else if (unit === "lac") abs = price * 1_00_000;
    else if (unit === "k") abs = price * 1_000;
    // Guard against implausible monthly rents (e.g. mis-stored "abs" values
    // like 12 or 185 rupees). Anything under ₹1,000/month is not a real Mumbai
    // rent — fall back rather than show a clearly-wrong number.
    if (abs < 1000) return "Price on request";
    return `₹${grouped(abs)}/month`;
  }

  // Sale / commercial
  if (unit === "cr") {
    // Most "cr" values are native-scale (2.5 => ₹2.5 Cr); large values are
    // absolute rupees mis-tagged as crore (85000000 => ₹8.5 Cr).
    const cr = price > 1000 ? price / 1_00_00_000 : price;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(2)} Cr`;
  }
  if (unit === "lac") {
    const v = price % 1 === 0 ? price : price.toFixed(1);
    return `₹${v} Lakh`;
  }
  if (unit === "k") {
    const abs = price > 1000 ? price : price * 1_000;
    return `₹${grouped(abs)}`;
  }
  // "abs" or unknown — render the grouped whole amount.
  return `₹${grouped(price)}`;
}

function buildTitle(row: ListingCardFields): string {
  // Prefer the real, regex/LLM-derived title computed at ingestion time.
  if (row.title && row.title.trim()) {
    return row.title.trim();
  }
  const ptype = (row.property_type || "").trim();
  const isCommercial = (row.asset_type || "").trim().toLowerCase() === "commercial";
  const building = row.building_name && row.building_name.trim();
  const locality = row.micro_market && row.micro_market.trim();

  // For commercial listings the property type (Office / Shop / Showroom /
  // Warehouse / Plot ...) is the most meaningful descriptor — lead with it so
  // the card immediately says what it is, instead of a garbled building_name.
  if (isCommercial && ptype && /[a-z]/i.test(ptype)) {
    const cap = ptype.charAt(0).toUpperCase() + ptype.slice(1);
    if (building && !/^(sq\.?\s*ft|multiple options|carpet|na\b)/i.test(building)) {
      return `${cap} — ${building}`;
    }
    if (locality) return `${cap} in ${locality}`;
    return cap;
  }

  if (building) {
    return building;
  }
  const bhk = (row.bhk || "").trim();
  if (bhk && locality) return `${bhk} — ${locality}`;
  if (bhk) return bhk;
  if (locality) return locality;
  if (row.landmark_name && row.landmark_name.trim()) return row.landmark_name.trim();
  return "Listing";
}

function buildSpecItems(row: ListingCardFields): ListingSpecItem[] {
  const items: ListingSpecItem[] = [];
  const ptype = (row.property_type || "").trim();
  if (ptype && /[a-z]/i.test(ptype)) {
    const cap = ptype.charAt(0).toUpperCase() + ptype.slice(1);
    items.push({ kind: "type", label: cap });
  }
  if (row.bhk && row.bhk.trim()) {
    items.push({ kind: "bhk", label: row.bhk.trim() });
  }
  if (typeof row.area_sqft === "number" && row.area_sqft > 0) {
    items.push({ kind: "area", label: `${row.area_sqft.toLocaleString("en-IN")} sqft` });
  }
  if (row.furnishing && row.furnishing.trim()) {
    items.push({ kind: "furnishing", label: row.furnishing.trim() });
  }
  if (row.floor_description && row.floor_description.trim()) {
    items.push({ kind: "floor", label: row.floor_description.trim() });
  }
  if (row.view && row.view.trim()) {
    items.push({ kind: "view", label: row.view.trim() });
  }
  return items;
}

function buildSpecRow(items: ListingSpecItem[]): string {
  return items.map((i) => i.label).join(" · ");
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "Recently";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Recently";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// Relative freshness for the card ("Today 2:30 PM", "Yesterday", "3d ago",
// or an absolute date for older listings). Backs the "freshness" claim with a
// real timestamp instead of a vague label.
function formatFreshness(iso: string | null): string {
  if (!iso) return "Recently";
  const date = new Date(iso);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return "Recently";
  const now = Date.now();
  const diffMs = now - ms;
  const dayMs = 24 * 60 * 60 * 1000;
  if (diffMs < 0) return "Just now";
  if (diffMs < dayMs) {
    const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
    return diffMs < 60 * 60 * 1000 ? "Just now" : `Today ${time}`;
  }
  if (diffMs < 2 * dayMs) return "Yesterday";
  if (diffMs < 7 * dayMs) return `${Math.floor(diffMs / dayMs)}d ago`;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// Short, SEO-friendly freshness badge for cards: emphasizes that PropAI's
// inventory changes continuously ("Just Landed", "Active today").
function formatFreshnessBadge(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  const now = Date.now();
  const diffMs = now - ms;
  if (diffMs < 0) return "Just Landed";
  if (diffMs < 60 * 60 * 1000) return "Just Landed";
  if (diffMs < 24 * 60 * 60 * 1000) return "Active today";
  return null;
}

// Broker contact must NEVER embed the phone number in public HTML (DPDP Act
// 2023 — phone is sensitive personal data). Instead we link to a server route
// that resolves the phone server-side and 302-redirects to wa.me, so the raw
// digits are never crawlable / exposed in the public DOM.
export function waLinkFor(listingId: number | null): string | null {
  if (listingId == null) return null;
  return `/api/contact-broker/${listingId}`;
}

// Strips decorative emoji / pictographs from display strings (broker names
// pulled from WhatsApp display names often contain ✨ ⚔️ 🕉️ etc.). Display-only
// cleanup — stored data is untouched.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200d]/gu;
export function stripEmoji(value: string | null): string | null {
  if (!value) return value;
  return value.replace(EMOJI_RE, "").replace(/\s{2,}/g, " ").trim() || null;
}

// Broker names are sometimes stored as raw phone numbers (e.g. "+91 9920993025"
// or "9930079206"). Never surface those in the public card DOM — mask them so
// the number is not crawlable / exposed (DPDP Act 2023). The real contact path
// is the /api/contact-broker/{id} redirect, which the server controls.
const PHONEISH = /[0-9]/;
export function safeBrokerName(raw: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const cleaned = stripEmoji(raw);
  if (!cleaned) return null;
  const v = cleaned.trim();
  // If it's mostly digits / a phone-shaped string, don't show it.
  const digitRatio = (v.match(/[0-9]/g) || []).length / Math.max(v.replace(/\s/g, "").length, 1);
  if (digitRatio > 0.5 || /^\+?\d[\d\s().-]{6,}$/.test(v)) return null;
  if (/wa\.me|whatsapp/i.test(v)) return null;
  return v;
}

export function toListingCardViewModel(
  row: ListingCardFields,
  isBuilding: boolean,
  fallbackLocality?: string | null,
): ListingCardViewModel {
  // On a building page, inherit the building's confirmed locality when the
  // individual listing failed to resolve its own micro_market.
  const ownLocality = row.micro_market && row.micro_market.trim() ? row.micro_market.trim() : null;
  const locality = ownLocality ?? (fallbackLocality && fallbackLocality.trim() ? fallbackLocality.trim() : null);
  const hasLocality = Boolean(locality);
  const specItems = buildSpecItems(row);
  return {
    title: buildTitle(row),
    locality,
    localitySlug: locality ? slugify(locality) : null,
    isBuilding,
    priceLabel: formatCardPrice(row.price, row.price_unit, row.intent),
    specRow: buildSpecRow(specItems),
    specItems,
    statusLabel: hasLocality ? "Available" : "Locality unconfirmed",
    statusTone: hasLocality ? "available" : "unconfirmed",
    updatedLabel: formatUpdated(row.last_seen),
    freshnessLabel: formatFreshness(row.last_seen),
    freshnessBadge: formatFreshnessBadge(row.last_seen),
    assetTypeLabel: assetTypeLabel(row.asset_type, row.intent),
    waLink: waLinkFor(row.id),
    href: row.id != null ? `/listings/${row.id}` : null,
    brokerName: safeBrokerName(row.broker_name),
  };
}
