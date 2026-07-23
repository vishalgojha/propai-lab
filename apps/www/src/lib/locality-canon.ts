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
//  - Standalone public pages are opt-in. Raw micro_market values are ingestion
//    data, not an editorial locality taxonomy, so an unknown value must never
//    automatically create a public location page.

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
  "pali hill": "Bandra West",
  "mount mary": "Bandra West",
  "turner road": "Bandra West",
  lokhandwala: "Andheri West",
  versova: "Andheri West",
  oshiwara: "Andheri West",
  "dn nagar": "Andheri West",
  marol: "Andheri East",
  sakinaka: "Andheri East",
  chandivali: "Andheri East",
  "juhu scheme": "Juhu",
  "hiranandani estate": "Thane West",
  "wagle estate, thane": "Thane West",
  kasarvadavali: "Thane West",
  kasarvadavli: "Thane West",
  kapurbawdi: "Thane West",
  "ghodbunder road, thane": "Thane West",
  "mahajanwadi, thane": "Thane West",
  "mahim west": "Mahim",
  "matunga east": "Matunga",
  "wadala west": "Wadala",
  "vile parle east": "Vile Parle East",
  "parle east": "Vile Parle East",
};

// The public browse taxonomy. Add a location here only after it has been
// reviewed as a market-level area, rather than relying on whatever free text
// happened to be assigned to listings during ingestion.
const STANDALONE_LOCALITIES: Record<string, string> = {
  "andheri east": "Andheri East",
  "andheri west": "Andheri West",
  ambernath: "Ambernath",
  agripada: "Agripada",
  badlapur: "Badlapur",
  "bandra east": "Bandra East",
  "bandra kurla complex": "Bandra Kurla Complex",
  "bandra west": "Bandra West",
  bhandup: "Bhandup",
  bhayandar: "Bhayandar",
  "borivali east": "Borivali East",
  "borivali west": "Borivali West",
  byculla: "Byculla",
  chembur: "Chembur",
  churchgate: "Churchgate",
  chowpatty: "Chowpatty",
  colaba: "Colaba",
  "cuffe parade": "Cuffe Parade",
  dahisar: "Dahisar",
  "dadar east": "Dadar East",
  "dadar west": "Dadar West",
  dombivli: "Dombivli",
  fort: "Fort",
  "ghatkopar east": "Ghatkopar East",
  "ghatkopar west": "Ghatkopar West",
  "goregaon east": "Goregaon East",
  "goregaon west": "Goregaon West",
  "grant road": "Grant Road",
  juhu: "Juhu",
  "jogeshwari east": "Jogeshwari East",
  "jogeshwari west": "Jogeshwari West",
  kalyan: "Kalyan",
  "kandivali east": "Kandivali East",
  "kandivali west": "Kandivali West",
  "khar west": "Khar West",
  kurla: "Kurla",
  "kurla west": "Kurla West",
  lalbaug: "Lalbaug",
  "lower parel": "Lower Parel",
  mahalaxmi: "Mahalaxmi",
  mahim: "Mahim",
  "malabar hill": "Malabar Hill",
  "malad east": "Malad East",
  "malad west": "Malad West",
  "marine lines": "Marine Lines",
  matunga: "Matunga",
  "mira road": "Mira Road",
  "mulund west": "Mulund West",
  "mumbai central": "Mumbai Central",
  "nariman point": "Nariman Point",
  nagpada: "Nagpada",
  nerul: "Nerul",
  panvel: "Panvel",
  parel: "Parel",
  powai: "Powai",
  prabhadevi: "Prabhadevi",
  pydhonie: "Pydhonie",
  "santacruz east": "Santacruz East",
  "santacruz west": "Santacruz West",
  sewri: "Sewri",
  sion: "Sion",
  tardeo: "Tardeo",
  "thane west": "Thane West",
  "vile parle west": "Vile Parle West",
  vashi: "Vashi",
  vasai: "Vasai",
  vikhroli: "Vikhroli",
  virar: "Virar",
  wadala: "Wadala",
  worli: "Worli",
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

  const label = STANDALONE_LOCALITIES[input];
  if (label) {
    return { label, slug: slugify(label), public: true, standalonePage: true };
  }

  // Unreviewed raw values remain available to ingestion and broad listing
  // search, but cannot appear in the public locality index or create a route.
  return { label: "", slug: "", public: false, standalonePage: false };
}

/** Convenience: is this raw value hidden from public pages? */
export function isHiddenLocality(raw: string | null | undefined): boolean {
  return !canonicalLocality(raw).public;
}
