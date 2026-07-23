import { slugify } from "./supabase";

export type ListingCardFields = {
  id: number;
  bhk: string | null;
  price: number | null;
  price_unit: string | null;
  price_model?: string | null;
  price_per_sqft?: number | null;
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
  deal_tags?: string[] | null;
  additional_charges?: AdditionalCharge[] | null;
};

export type AdditionalCharge = {
  label: string;
  amount: number | null;
  amount_type: "fixed" | "percent_of_price";
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
  slug: string | null;
  waAvailable: boolean;
  brokerName: string | null;
  priceModel: string | null;
  pricePerSqft: number | null;
  dealTags: Array<{ tag: string; label: string; tone: string }>;
  additionalCharges: Array<{ label: string; amountLabel: string }>;
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
//   - "psf": price is per-sqft; total = price_per_sqft * area_sqft (unit = abs).
// We normalise each to a readable, grouped amount in the appropriate unit.
export function formatCardPrice(
  price: number | null,
  priceUnit: string | null,
  intent: string | null,
  priceModel: string | null = null,
  pricePerSqft: number | null = null,
  areaSqft: number | null = null,
): string {
  const unit = normalizeUnit(priceUnit);
  const intentKind = intentValue(intent);
  const perMonth = intentKind === "rent";

  // If price model is per-sqft and we have area, compute total price
  if (priceModel === "psf" && pricePerSqft != null && areaSqft != null && areaSqft > 0) {
    const totalPrice = pricePerSqft * areaSqft;
    // For sale, render as absolute rupees with appropriate unit
    const grouped = (n: number) => Math.round(n).toLocaleString("en-IN");
    if (totalPrice >= 1_00_00_000) {
      const cr = totalPrice / 1_00_00_000;
      return `₹${cr % 1 === 0 ? cr : cr.toFixed(2)} Cr`;
    }
    if (totalPrice >= 1_00_000) {
      const lac = totalPrice / 1_00_000;
      return `₹${lac % 1 === 0 ? lac : lac.toFixed(1)} Lakh`;
    }
    return `₹${Math.round(totalPrice).toLocaleString("en-IN")}`;
  }

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

function titleCase(value: string): string {
  return value
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildTitle(row: ListingCardFields): string {
  // A raw WhatsApp title is evidence, not display copy.  It is often merely
  // a building name (or a noisy poster headline), which made equivalent cards
  // read as "Ten BKC", "3 BHK — BKC", and "Available Ten bkc 3bhk".  Build
  // one deterministic title from the structured fields for every card.
  const furnishing = (row.furnishing || "").trim();
  const bhk = (row.bhk || "").trim();
  const propertyType = (row.property_type || "").trim();
  const building = row.building_name?.trim() || null;
  const locality = row.micro_market?.trim() || row.location_label?.trim() || null;
  const intent = intentValue(row.intent);
  const transaction = intent === "rent" ? "for Rent" : intent === "sale" ? "for Sale" : "";

  const descriptor = [
    furnishing ? titleCase(furnishing) : "",
    bhk || (propertyType ? titleCase(propertyType) : "Property"),
  ].filter(Boolean).join(" ");
  const place = building || locality || row.landmark_name?.trim() || null;

  if (place && transaction) return `${descriptor} ${transaction} at ${place}`;
  if (place) return `${descriptor} at ${place}`;
  if (transaction) return `${descriptor} ${transaction}`;
  return descriptor;
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
  // Reject garbage text that the LLM sometimes extracts as broker names.
  const low = v.toLowerCase();
  const GARBAGE = (
    "stamp duty|furnished|carpet|bhk|sqft|sq ft|ready to move|negotiable|"
    + "balcon|sea view|amenities|parking|deposit|possession|available|"
    + "options|benefit|family|bachelor|veg|non-veg|near|opp|opposite|"
    + "behind|floor|tower|residency|heights|apartment|regards|thank|"
    + "hello|dear|rent|sale|commercial|office|shop|lift|backup|"
    + "security|power|gym|swimming|landmark|station|price|asking|"
    + "location|coverage|capacity|reception|entrance|ground|first|"
    + "second|third|fourth|fifth|upper|lower|basement|dedicated|"
    + "visitor|ample|separate|exclusive|ready|restaurant|central|"
    + "suburb|mumbai"
  );
  if (new RegExp(GARBAGE).test(low)) return null;
  // Too short or too long to be a real name.
  if (v.length < 2 || v.length > 50) return null;
  // All-caps single word is usually not a name (e.g. "FURNISHED").
  if (v === v.toUpperCase() && !v.includes(" ")) return null;
  return v;
}

// True when the stored broker_phone can be coerced to a 10-digit Indian mobile
// (with or without the +91 prefix). Mirrors the server-side check in the
// /api/contact-broker/[id] route so the public card never shows a "Contact on
// WhatsApp" button that would just 302 back to the listing page.
export function isBrokerContactable(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length < 10) return false;
  const local = digits.length > 10 ? digits.slice(-10) : digits;
  return local.length === 10;
}

// SEO-friendly slug for the public /listings/[slug]/[id] route. Format:
//   `{bhk-or-property-type}-{locality-or-empty}-{id}`
// The id is always appended so the URL is unique even when the prefix is empty
// or repeats. Examples:
//   bhk="3 BHK", micro_market="Andheri West", id=319236 → "3-bhk-andheri-west-319236"
//   bhk=null, micro_market=null, id=319236              → "319236"
//   bhk="2.5 BHK", micro_market="Powai", id=999         → "2-5-bhk-powai-999"
// Use this from listing-card.ts, sitemap.ts, and contact-broker route so all
// three surfaces point at the same canonical URL.
export type SlugInput = {
  id: number;
  bhk?: string | null;
  micro_market?: string | null;
  building_name?: string | null;
  property_type?: string | null;
};

export function buildListingSlug(input: SlugInput): string | null {
  if (!Number.isFinite(input.id)) return null;
  const id = String(input.id);
  const parts: string[] = [];
  const bhk = (input.bhk ?? "").trim();
  if (bhk) parts.push(slugify(bhk));
  // Prefer the locality when present, then fall back to the building name —
  // either alone gives Google a usable keyword on the URL.
  const micro = (input.micro_market ?? "").trim();
  if (micro) parts.push(slugify(micro));
  else {
    const bldg = (input.building_name ?? "").trim();
    if (bldg && !/^(sq\.?\s*ft|multiple options|carpet|na\b)/i.test(bldg)) {
      parts.push(slugify(bldg));
    }
  }
  // If both bhk and locality/building are missing, the slug is just the id.
  // Otherwise join with hyphens, then suffix the id for uniqueness.
  if (parts.length === 0) return id;
  // Filter out empty parts (e.g. if bhk was just whitespace), then join.
  const filtered = parts.filter((p) => p.length > 0);
  if (filtered.length === 0) return id;
  return `${filtered.join("-")}-${id}`;
}

// Deal-tag taxonomy — mirrors the whitelist enforced server-side in
// ai_extraction._VALID_DEAL_TAGS. Tone buckets are public-site Tailwind class
// fragments (border + bg + text). Kept in this file so the card + detail
// page stay in sync without prop drilling.
const DEAL_TAG_LABELS: Record<string, string> = {
  distress_sale: "Distress sale",
  urgent_sale: "Urgent sale",
  negotiable: "Negotiable",
  bank_auction: "Bank auction",
  resale: "Resale",
  exclusive_mandate: "Exclusive mandate",
  price_drop: "Price drop",
};

const DEAL_TAG_TONES: Record<string, string> = {
  distress_sale: "border-red-400/30 bg-red-400/10 text-red-300",
  urgent_sale: "border-orange-400/30 bg-orange-400/10 text-orange-300",
  negotiable: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  bank_auction: "border-blue-400/30 bg-blue-400/10 text-blue-300",
  resale: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300",
  exclusive_mandate: "border-purple-400/30 bg-purple-400/10 text-purple-300",
  price_drop: "border-cyan-400/30 bg-cyan-400/10 text-cyan-300",
};

export function buildDealTags(raw: string[] | null | undefined): ListingCardViewModel["dealTags"] {
  if (!raw || raw.length === 0) return [];
  const out: ListingCardViewModel["dealTags"] = [];
  for (const tag of raw) {
    if (typeof tag !== "string") continue;
    const key = tag.trim().toLowerCase();
    if (!key) continue;
    const label = DEAL_TAG_LABELS[key];
    const tone = DEAL_TAG_TONES[key];
    if (!label || !tone) continue; // whitelist — drop anything we don't recognise
    out.push({ tag: key, label, tone });
  }
  return out;
}

// Compact Indian-currency formatter for additional charge lines: 1000000 → "₹10L",
// 3500000 → "₹35L", 15000000 → "₹1.5Cr". Mirrors formatCardPrice units but is
// purely display-side; server stores `amount` as raw INR.
function formatChargeAmount(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "₹—";
  if (amount >= 1_00_00_000) {
    const cr = amount / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(1)}Cr`;
  }
  if (amount >= 1_00_000) {
    const lac = amount / 1_00_000;
    return `₹${lac % 1 === 0 ? lac.toFixed(0) : lac.toFixed(1)}L`;
  }
  if (amount >= 1_000) {
    const k = amount / 1_000;
    return `₹${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}K`;
  }
  return `₹${amount.toLocaleString("en-IN")}`;
}

export function buildAdditionalCharges(
  raw: AdditionalCharge[] | null | undefined,
): ListingCardViewModel["additionalCharges"] {
  if (!raw || raw.length === 0) return [];
  const out: ListingCardViewModel["additionalCharges"] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const label = typeof c.label === "string" ? c.label.trim() : "";
    if (!label) continue;
    if (c.amount_type === "percent_of_price" && typeof c.amount === "number" && Number.isFinite(c.amount)) {
      const pct = c.amount;
      out.push({ label, amountLabel: `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2)}% of price` });
      continue;
    }
    if (c.amount_type === "fixed" && typeof c.amount === "number" && Number.isFinite(c.amount) && c.amount > 0) {
      out.push({ label, amountLabel: `+ ${formatChargeAmount(c.amount)}` });
      continue;
    }
    // Malformed entry — drop silently rather than render "undefined%".
  }
  return out;
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
  // Compute the SEO slug once so card href, JSON-LD, sitemap, and the
  // back-compat redirect all agree on the canonical URL.
  const slug = row.id != null
    ? buildListingSlug({
        id: row.id,
        bhk: row.bhk,
        micro_market: row.micro_market,
        building_name: row.building_name,
        property_type: row.property_type,
      })
    : null;
  return {
    title: buildTitle(row),
    locality,
    localitySlug: locality ? slugify(locality) : null,
    isBuilding,
    priceLabel: formatCardPrice(row.price, row.price_unit, row.intent, row.price_model, row.price_per_sqft, row.area_sqft),
    specRow: buildSpecRow(specItems),
    specItems,
    statusLabel: hasLocality ? "Available" : "Locality unconfirmed",
    statusTone: hasLocality ? "available" : "unconfirmed",
    updatedLabel: formatUpdated(row.last_seen),
    freshnessLabel: formatFreshness(row.last_seen),
    freshnessBadge: formatFreshnessBadge(row.last_seen),
    assetTypeLabel: assetTypeLabel(row.asset_type, row.intent),
    waLink: waLinkFor(row.id),
    // The public route is /listings/[slug]/[id].  Keeping both segments here
    // prevents every card click/prefetch from requesting a one-segment 404.
    slug,
    href: row.id != null && Number.isFinite(row.id)
      ? `/listings/${slug ?? "listing"}/${row.id}`
      : null,
    waAvailable: isBrokerContactable(row.broker_phone),
    brokerName: safeBrokerName(row.broker_name),
    priceModel: row.price_model ?? null,
    pricePerSqft: row.price_per_sqft ?? null,
    dealTags: buildDealTags(row.deal_tags),
    additionalCharges: buildAdditionalCharges(row.additional_charges),
  };
}
