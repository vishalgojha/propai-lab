// Canonical locality mapping for www.propai.live.
//
// Purpose: normalise the dirty `micro_market` strings that accumulated in the
// DB before any normaliser existed. The www read path resolves every raw value
// through this module so duplicates merge, non-places hide, and implied
// directions map to a confirmed canonical label — without needing a backfill
// first. The backfill script (scripts/backfill_canonical_localities.py) applies
// the same rules to the stored rows.
//
// Rules are confirmed against WhatsApp group data (no guesswork):
//  - Always trim + case-fold for comparison.
//  - Implied-direction applies to ONLY these three bare parents:
//      "Bandra"        -> Bandra West
//      "Khar"          -> Khar West
//      "Santacruz"/"Scuz" -> Santacruz West
//  - BKC handling:
//      "Bandra BKC" / "Bandra Bkc" / "Bandra East BKC" -> Bandra East
//      "BKC" (bare, no Bandra prefix)                  -> Bandra Kurla Complex
//  - These generic parents stay as their own bucket, with NO automatic
//    East/West assumption and NO standalone public page (general search only):
//      Andheri, Dadar, Thane, Malad, Goregaon, Vile Parle, Kandivali, Borivali
//  - Non-place internal buckets are hidden from public pages entirely:
//      "Western Suburbs Prime", "South Mumbai Central", "Eastern Suburbs", etc.

import { slugify } from "./supabase";

export type CanonicalLocality = {
  /** Display label, e.g. "Bandra West". */
  label: string;
  /** URL slug, e.g. "bandra-west". */
  slug: string;
  /** True if this locality should appear anywhere on public pages. */
  public: boolean;
  /** True if this locality gets its own /localities/[slug] detail page.
   *  Generic parents (Andheri, Dadar, ...) are false — surfaced only via
   *  general search to avoid Bandra-BKC-style ambiguity confusion. */
  standalonePage: boolean;
};

// Non-place internal buckets → hidden from all public surfaces.
const HIDDEN_BUCKETS = new Set<string>([
  "western suburbs prime",
  "south mumbai central",
  "eastern suburbs",
  "central suburbs",
  "mumbai suburbs",
  "western line",
  "central line",
  "harbour line",
]);

// Generic parents that keep their own bucket but get NO standalone page.
const GENERIC_PARENTS = new Set<string>([
  "andheri",
  "dadar",
  "thane",
  "malad",
  "goregaon",
  "vile parle",
  "kandivali",
  "borivali",
]);

// Implied-direction map (bare parent -> confirmed canonical label).
const IMPLIED_DIRECTION: Record<string, string> = {
  bandra: "Bandra West",
  khar: "Khar West",
  santacruz: "Santacruz West",
  scuz: "Santacruz West",
};

// Explicit redirects (case-folded raw -> canonical label).
const REDIRECTS: Record<string, string> = {
  "bandra bkc": "Bandra East",
  "bandra bkc east": "Bandra East",
  "bandra east bkc": "Bandra East",
  bkc: "Bandra Kurla Complex",
};

function normalise(raw: string): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function canonicalLocality(raw: string | null | undefined): CanonicalLocality {
  const input = normalise(raw ?? "");
  if (!input) {
    return { label: "", slug: "", public: false, standalonePage: false };
  }

  // Hidden internal buckets.
  if (HIDDEN_BUCKETS.has(input)) {
    return { label: "", slug: "", public: false, standalonePage: false };
  }

  // Explicit redirects (most specific first).
  if (REDIRECTS[input]) {
    const label = REDIRECTS[input];
    return { label, slug: slugify(label), public: true, standalonePage: true };
  }

  // Implied direction for the three confirmed bare parents.
  if (IMPLIED_DIRECTION[input]) {
    const label = IMPLIED_DIRECTION[input];
    return { label, slug: slugify(label), public: true, standalonePage: true };
  }

  // Generic parent: keep own bucket, no standalone page, but still public
  // (surfaced via general search).
  if (GENERIC_PARENTS.has(input)) {
    const label = raw!.trim().replace(/\s+/g, " ");
    return { label, slug: slugify(label), public: true, standalonePage: false };
  }

  // Everything else: keep as-is, public with its own page.
  const label = raw!.trim().replace(/\s+/g, " ");
  return { label, slug: slugify(label), public: true, standalonePage: true };
}

/** Convenience: is this raw value hidden from public pages? */
export function isHiddenLocality(raw: string | null | undefined): boolean {
  return !canonicalLocality(raw).public;
}
