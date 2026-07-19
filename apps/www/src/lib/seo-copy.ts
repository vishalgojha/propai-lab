// Centralized, intent-driven SEO copy generation for PropAI.
// All titles/descriptions are produced here so every route stays consistent
// with the editorial rules:
//   - primary keyword first, human readable
//   - brand ("PropAI") always at the very end
//   - never start with "PropAI"
//   - under ~60 chars for titles where possible
//   - descriptions 140-160 chars, natural language, no broken numbers

export type Txn = "sale" | "rent";

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// ---- Locality titles -------------------------------------------------------

export function localityTitle(locality: string): string {
  return `${locality} Properties for Sale & Rent | PropAI`;
}

export function localityTxnTitle(locality: string, txn: Txn): string {
  const verb = txn === "rent" ? "for Rent" : "for Sale";
  return `${locality} Properties ${verb} | PropAI`;
}

export function localityBhkTitle(locality: string, bhk: string): string {
  return `${bhk} Flats in ${locality} | Live Listings | PropAI`;
}

export function localityBudgetTitle(
  locality: string,
  bhk: string | null,
  txn: Txn,
  budgetLabel: string,
): string {
  const subject = bhk ? `${bhk} in ${locality}` : `${titleCase(locality)} property`;
  const verb = txn === "rent" ? "for Rent" : "for Sale";
  return `${subject} ${budgetLabel} ${verb} | PropAI`;
}

export function localityCommercialTitle(locality: string, kind: string): string {
  return `${titleCase(kind)} in ${locality} | Live Broker Listings | PropAI`;
}

// ---- Building titles -------------------------------------------------------

export function buildingTitle(name: string): string {
  return `${name} | Live Listings | PropAI`;
}

export function buildingTxnTitle(name: string, txn: Txn): string {
  const verb = txn === "rent" ? "for Rent" : "for Sale";
  return `${name} ${verb} | Live Listings | PropAI`;
}

// ---- Listing / 3BHK / budget generic --------------------------------------

export function listingTitle(card: {
  title: string;
  locality: string | null;
  priceLabel: string;
}): string {
  const where = card.locality ? ` in ${card.locality}` : "";
  const base = card.title || "Property";
  if (card.priceLabel && card.priceLabel !== "Price on request") {
    return `${base}${where} — ${card.priceLabel} | PropAI`;
  }
  return `${base}${where} | PropAI`;
}

export function searchTitle(query: string): string {
  const q = query.trim();
  if (!q) return "Search Property Listings | PropAI";
  return `${q} | Live Property Search | PropAI`;
}

// ---- Programmatic sub-page titles (locality x txn / bhk / budget / commercial) ----

export function localitySegmentTitle(
  locality: string,
  segment: "sale" | "rent" | "commercial",
): string {
  if (segment === "commercial") return `${titleCase(locality)} Commercial Properties | Live Listings | PropAI`;
  const verb = segment === "rent" ? "for Rent" : "for Sale";
  return `${locality} Properties ${verb} | PropAI`;
}

export function localityBhkSegmentTitle(locality: string, bhk: number): string {
  const label = bhk >= 5 ? "5+ BHK" : `${bhk} BHK`;
  return `${label} Flats in ${locality} | Live Listings | PropAI`;
}

export function localityBudgetSegmentTitle(
  locality: string,
  budgetLabel: string,
  txn: Txn,
): string {
  const subject = `${titleCase(locality)} property`;
  const verb = txn === "rent" ? "for Rent" : "for Sale";
  return `${subject} ${budgetLabel} ${verb} | PropAI`;
}

export function localitySegmentDescription(opts: {
  locality: string;
  segmentLabel: string;
  listingCount: number;
  txn: Txn;
}): string {
  const { locality, segmentLabel, listingCount, txn } = opts;
  const verb = txn === "rent" ? "for rent" : "for sale";
  const parts: string[] = [];
  parts.push(
    `Explore ${listingCount.toLocaleString("en-IN")} live ${segmentLabel} listings in ${locality} ${verb}.`,
  );
  parts.push("Filter by budget, furnishing and building, then contact the listing broker instantly on WhatsApp.");
  return clip(parts.join(" "), 155);
}

// ---- Descriptions (natural language, 140-160 chars) -----------------------

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1).replace(/\s+\S*$/, "");
  return `${cut}.`;
}

export function localityDescription(opts: {
  locality: string;
  totalListings: number;
  buildingCount: number;
  saleCount: number;
  rentCount: number;
  topBhk: string | null;
}): string {
  const { locality, totalListings, buildingCount, saleCount, rentCount, topBhk } = opts;
  const parts: string[] = [];
  parts.push(
    `Browse ${totalListings.toLocaleString("en-IN")} live ${locality} property listings across ${buildingCount} buildings.`,
  );
  if (saleCount > 0 && rentCount > 0) {
    parts.push(`Includes ${saleCount} for sale and ${rentCount} for rent.`);
  } else if (saleCount > 0) {
    parts.push(`Includes ${saleCount} for sale.`);
  } else if (rentCount > 0) {
    parts.push(`Includes ${rentCount} for rent.`);
  }
  if (topBhk) parts.push(`${topBhk} homes are most common.`);
  parts.push("Connect directly with verified brokers. Updated in real time.");
  return clip(parts.join(" "), 155);
}

export function buildingDescription(opts: {
  name: string;
  locality: string | null;
  listingCount: number;
  saleCount: number;
  rentCount: number;
}): string {
  const { name, locality, listingCount, saleCount, rentCount } = opts;
  const where = locality ? ` in ${locality}` : "";
  const parts: string[] = [];
  parts.push(
    `Explore ${listingCount.toLocaleString("en-IN")} live listings at ${name}${where}.`,
  );
  if (saleCount > 0 && rentCount > 0) {
    parts.push(`${saleCount} for sale, ${rentCount} for rent.`);
  } else if (saleCount > 0) {
    parts.push(`${saleCount} available for sale.`);
  } else if (rentCount > 0) {
    parts.push(`${rentCount} available for rent.`);
  }
  parts.push("Contact the posting broker instantly on WhatsApp.");
  return clip(parts.join(" "), 155);
}

export function listingDescription(opts: {
  dealType: "For rent" | "For sale";
  title: string;
  locality: string | null;
  specRow: string;
}): string {
  const { dealType, title, locality, specRow } = opts;
  const where = locality ? ` in ${locality}` : " in Mumbai";
  const parts: string[] = [];
  parts.push(`${dealType} — ${title}${where}.`);
  if (specRow) parts.push(`${specRow}.`);
  parts.push("Listed via Mumbai's live WhatsApp broker network. Contact the broker directly, no lead forms.");
  return clip(parts.join(" "), 155);
}

export function searchDescription(query: string): string {
  const q = query.trim() || "Mumbai";
  return clip(
    `Explore live ${q} property listings from Mumbai's WhatsApp broker network. Filter by budget, furnishing and building, then contact the listing broker instantly.`,
    158,
  );
}
