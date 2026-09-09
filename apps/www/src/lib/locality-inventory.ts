import { canonicalLocality } from "./locality-canon";
import { slugify } from "./supabase";

export type InventoryGroup = {
  micro_market: string | null; locality_resolved: string | null; locality_raw: string | null;
  card_type: string; configuration: string | null; listing_count: number;
  active_24h: number; last_seen: string; priced_count: number;
  min_price: number | null; max_price: number | null;
};
export type LocalityReference = {
  sub_locality: string; parent_locality: string; canonical_locality: string | null;
  city: string | null; alternate_names: string[] | null;
};
export type InventoryResponse = { as_of: string; window_days: number; groups: InventoryGroup[]; registry: LocalityReference[] };
export type InventorySegment = {
  cardType: string; bhk: string | null; count: number; pricedCount: number;
  minPrice: number | null; maxPrice: number | null;
};
export type InventoryLocality = {
  locality: string; slug: string; city: string | null; standalonePage: boolean;
  listingCount: number; rentCount: number; saleCount: number; commercialCount: number;
  active24h: number; lastSeen: string; segments: InventorySegment[];
};
export type InventorySnapshot = {
  asOf: string; localities: InventoryLocality[]; totalRecords: number;
  unmappedRecords: number; mappedRecords: number;
};

const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

/** Only approved taxonomy/registry names become labels. Unknown raw text is
 * accounted for, never advertised as a place or used to create an SEO route. */
export function summarizeLocalityInventory(input: InventoryResponse): InventorySnapshot {
  if (!input || !Array.isArray(input.groups) || !Array.isArray(input.registry)
    || !Number.isFinite(Date.parse(input.as_of)) || input.window_days !== 30) {
    throw new Error("Invalid locality inventory response");
  }
  const references = new Map<string, Map<string, { label: string; city: string | null }>>();
  for (const ref of input.registry) {
    const label = ref.canonical_locality || ref.parent_locality || ref.sub_locality;
    if (!label) continue;
    for (const alias of [label, ref.sub_locality, ref.parent_locality, ...(ref.alternate_names ?? [])]) {
      if (!alias) continue;
      const candidates = references.get(key(alias)) ?? new Map();
      candidates.set(`${key(label)}:${ref.city ?? ""}`, { label, city: ref.city || null });
      references.set(key(alias), candidates);
    }
  }
  const places = new Map<string, InventoryLocality>();
  let totalRecords = 0, unmappedRecords = 0;
  for (const group of input.groups) {
    const count = Number(group.listing_count);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid inventory count");
    totalRecords += count;
    let place: { label: string; slug: string; city: string | null; standalonePage: boolean } | null = null;
    for (const raw of [group.locality_resolved, group.micro_market, group.locality_raw]) {
      if (!raw?.trim()) continue;
      const canon = canonicalLocality(raw);
      const candidates = references.get(key(raw)) ?? (canon.public ? references.get(key(canon.label)) : undefined);
      // Do not guess which city an ambiguous registry label belongs to.
      if (candidates && candidates.size > 1) continue;
      const ref = candidates?.values().next().value;
      if (ref) {
        const resolved = canonicalLocality(ref.label);
        place = { label: resolved.public ? resolved.label : ref.label,
          slug: resolved.public ? resolved.slug : slugify(ref.label), city: ref.city,
          standalonePage: resolved.standalonePage };
      } else if (canon.public) {
        place = { label: canon.label, slug: canon.slug, city: null, standalonePage: canon.standalonePage };
      }
      if (place) break;
    }
    if (!place) { unmappedRecords += count; continue; }
    const placeKey = `${place.city ?? ""}:${place.slug}`;
    const loc = places.get(placeKey) ?? {
      locality: place.label, slug: place.slug, city: place.city, standalonePage: place.standalonePage,
      listingCount: 0, rentCount: 0, saleCount: 0, commercialCount: 0,
      active24h: 0, lastSeen: group.last_seen, segments: [],
    };
    loc.listingCount += count;
    if (group.card_type.endsWith("_rent")) loc.rentCount += count;
    if (group.card_type.endsWith("_sale")) loc.saleCount += count;
    if (group.card_type.startsWith("commercial_")) loc.commercialCount += count;
    loc.active24h += Number(group.active_24h);
    if (group.last_seen > loc.lastSeen) loc.lastSeen = group.last_seen;
    let segment = loc.segments.find(s => s.cardType === group.card_type && s.bhk === group.configuration);
    if (!segment) {
      segment = { cardType: group.card_type, bhk: group.configuration, count: 0, pricedCount: 0, minPrice: null, maxPrice: null };
      loc.segments.push(segment);
    }
    segment.count += count;
    segment.pricedCount += Number(group.priced_count);
    if (group.min_price != null) segment.minPrice = Math.min(segment.minPrice ?? Infinity, Number(group.min_price));
    if (group.max_price != null) segment.maxPrice = Math.max(segment.maxPrice ?? -Infinity, Number(group.max_price));
    places.set(placeKey, loc);
  }
  const localities = [...places.values()].sort((a, b) => b.listingCount - a.listingCount || a.locality.localeCompare(b.locality));
  for (const loc of localities) loc.segments.sort((a, b) => b.count - a.count || a.cardType.localeCompare(b.cardType));
  return { asOf: input.as_of, localities, totalRecords, unmappedRecords, mappedRecords: totalRecords - unmappedRecords };
}
