import { slugify } from "./supabase";

export type ListingCardFields = {
  id: number;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  area_sqft: number | null;
  furnishing: string | null;
  intent: string | null;
  micro_market: string | null;
  building_name: string | null;
  landmark_name: string | null;
  location_label: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  last_seen: string | null;
};

export type ListingCardViewModel = {
  title: string;
  locality: string | null;
  localitySlug: string | null;
  isBuilding: boolean;
  priceLabel: string;
  specRow: string;
  statusLabel: string;
  statusTone: "available" | "unconfirmed";
  updatedLabel: string;
  waLink: string | null;
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

// Renders an explicit, buyer-readable price with a unit. Never a bare number.
// Unit is derived from price_unit + intent; if the unit isn't reliably known
// we show "Price on request" rather than guessing a lakh/crore scale.
export function formatCardPrice(
  price: number | null,
  priceUnit: string | null,
  intent: string | null,
): string {
  const unit = normalizeUnit(priceUnit);
  const intentKind = intentValue(intent);

  if (price == null) return "Price on request";

  // Rentals are quoted per month.
  if (intentKind === "rent") {
    const rounded = Math.round(price);
    return `₹${rounded.toLocaleString("en-IN")}/month`;
  }

  // price is stored in the unit's native scale (Cr/Lac/K/abs), so render it
  // directly — do NOT divide by a crore/lakh factor.
  if (unit === "cr") {
    return `₹${price % 1 === 0 ? price : price.toFixed(2)} Cr`;
  }
  if (unit === "lac") {
    return `₹${price % 1 === 0 ? price : price.toFixed(1)} Lakh`;
  }
  if (unit === "k") {
    return `₹${Math.round(price).toLocaleString("en-IN")}K`;
  }

  // "abs" (absolute rupees) — render the whole-currency amount.
  if (unit === "abs") {
    return `₹${Math.round(price).toLocaleString("en-IN")}`;
  }

  // No usable unit: do not invent a scale.
  return "Price on request";
}

function buildTitle(row: ListingCardFields): string {
  if (row.building_name && row.building_name.trim()) {
    return row.building_name.trim();
  }
  const bhk = (row.bhk || "").trim();
  const locality = row.micro_market && row.micro_market.trim();
  if (bhk && locality) return `${bhk} — ${locality}`;
  if (bhk) return bhk;
  if (locality) return locality;
  if (row.landmark_name && row.landmark_name.trim()) return row.landmark_name.trim();
  return "Listing";
}

function buildSpecRow(row: ListingCardFields): string {
  const parts: string[] = [];
  if (row.bhk && row.bhk.trim()) parts.push(row.bhk.trim());
  if (typeof row.area_sqft === "number" && row.area_sqft > 0) {
    parts.push(`${row.area_sqft.toLocaleString("en-IN")} sqft`);
  }
  if (row.furnishing && row.furnishing.trim()) parts.push(row.furnishing.trim());
  return parts.join(" · ");
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "Recently";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Recently";
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

// Shared wa.me deep-link logic, consistent with Market Inbox (frontend).
export function waLinkFor(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const local = digits.endsWith("91") && digits.length > 10 ? digits.slice(-10) : digits.slice(-10);
  if (local.length !== 10) return null;
  return `https://wa.me/91${local}`;
}

export function toListingCardViewModel(row: ListingCardFields, isBuilding: boolean): ListingCardViewModel {
  const locality = row.micro_market && row.micro_market.trim() ? row.micro_market.trim() : null;
  const hasLocality = Boolean(locality);
  return {
    title: buildTitle(row),
    locality,
    localitySlug: locality ? slugify(locality) : null,
    isBuilding,
    priceLabel: formatCardPrice(row.price, row.price_unit, row.intent),
    specRow: buildSpecRow(row),
    statusLabel: hasLocality ? "Available" : "Locality unconfirmed",
    statusTone: hasLocality ? "available" : "unconfirmed",
    updatedLabel: formatUpdated(row.last_seen),
    waLink: waLinkFor(row.broker_phone),
    brokerName: row.broker_name && row.broker_name.trim() ? row.broker_name.trim() : null,
  };
}
