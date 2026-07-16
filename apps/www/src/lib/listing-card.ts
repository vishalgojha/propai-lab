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
  floor_description?: string | null;
  view?: string | null;
  title?: string | null;
  broker_name: string | null;
  broker_phone: string | null;
  last_seen: string | null;
};

// Structured spec entries so callers can render an icon per spec (bed count,
// area, furnishing, floor...) instead of one flat "3 BHK · 850 sqft" string.
export type ListingSpecItem = {
  kind: "bhk" | "area" | "furnishing" | "floor" | "view";
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

  // Rentals are quoted per month. price is stored in the unit's native scale
  // (Cr/Lac/K/abs), so scale it to absolute rupees before formatting.
  if (intentKind === "rent") {
    let abs = price;
    if (unit === "cr") abs = price * 1_00_00_000;
    else if (unit === "lac") abs = price * 1_00_000;
    else if (unit === "k") abs = price * 1_000;
    // unit === "abs" or null/unknown: treat as absolute rupees
    return `₹${Math.round(abs).toLocaleString("en-IN")}/month`;
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
  // Prefer the real, regex/LLM-derived title computed at ingestion time.
  if (row.title && row.title.trim()) {
    return row.title.trim();
  }
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

function buildSpecItems(row: ListingCardFields): ListingSpecItem[] {
  const items: ListingSpecItem[] = [];
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

// Broker contact must NEVER embed the phone number in public HTML (DPDP Act
// 2023 — phone is sensitive personal data). Instead we link to a server route
// that resolves the phone server-side and 302-redirects to wa.me, so the raw
// digits are never crawlable / exposed in the public DOM.
export function waLinkFor(listingId: number | null): string | null {
  if (listingId == null) return null;
  return `/contact-broker/${listingId}`;
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
    waLink: waLinkFor(row.id),
    href: row.id != null ? `/listings/${row.id}` : null,
    brokerName: row.broker_name && row.broker_name.trim() ? row.broker_name.trim() : null,
  };
}
