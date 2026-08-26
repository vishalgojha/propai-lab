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
  "western suburbs mid",
  "western suburbs extended",
  "western suburbs far",
  "south mumbai central",
  "south mumbai prime",
  "eastern suburbs",
  "eastern suburbs prime",
  "eastern suburbs extended",
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
  // Both labels are the same locality; the DB canonical key is exposed with
  // the full display label so URLs and cards converge.
  bkc: "Bandra Kurla Complex",
  "bandra kurla complex": "Bandra Kurla Complex",
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

// Generated from public.locality_reference.canonical_locality. This keeps
// frontend reads aligned with Python extraction and the DB reference table.
const LOCALITY_REFERENCE_CANONICAL: Record<string, string> = {
  "union park": "Bandra West",
  "carter road": "Bandra West",
  "carter rd": "Bandra West",
  "pali hill": "Bandra West",
  "hill road": "Bandra West",
  "hill rd": "Bandra West",
  "linking road": "Bandra West",
  "linking rd": "Bandra West",
  "turner road": "Bandra West",
  "turner rd": "Bandra West",
  "st. andrews road": "Bandra West",
  "st andrews rd": "Bandra West",
  "st andrews road": "Bandra West",
  "bandstand": "Bandra West",
  "mount mary": "Bandra West",
  "ranwar": "Bandra West",
  "sherly rajan village": "Bandra West",
  "borla village": "Bandra West",
  "khar danda": "Bandra West",
  "chimbai road": "Bandra West",
  "chimbai rd": "Bandra West",
  "bandra reclamation": "Bandra West",
  "waterfield road": "Bandra West",
  "waterfield rd": "Bandra West",
  "perry road": "Bandra West",
  "perry rd": "Bandra West",
  "mig colony": "Bandra East",
  "mig bandra": "Bandra East",
  "bandra east": "Bandra East",
  "kalanagar": "Bandra East",
  "bharat nagar": "Bandra East",
  "naval nagar": "Bandra East",
  "bandra kurla complex": "Bandra Kurla Complex",
  "bkc": "Bandra Kurla Complex",
  "g block bkc": "Bandra Kurla Complex",
  "g block": "Bandra Kurla Complex",
  "juhu tara road": "Juhu",
  "juhu tara rd": "Juhu",
  "juhu versova link road": "Andheri West",
  "jvlr": "Juhu",
  "juhu scheme": "Juhu",
  "mitha nagar": "Juhu",
  "gulmohar road": "Juhu",
  "gulmohar rd": "Juhu",
  "nesco": "Juhu",
  "khar west": "Khar West",
  "khar": "Khar West",
  "khar (15th road)": "Khar West",
  "khar 15th road": "Khar West",
  "khar gymkhana": "Khar West",
  "14th road khar": "Khar West",
  "sahar road": "Khar West",
  "sahar rd": "Khar West",
  "santacruz west": "Santacruz West",
  "santacruz": "Santacruz West",
  "santa cruz west": "Santacruz West",
  "santa cruz": "Santacruz West",
  "vakola": "Santacruz West",
  "kharak pada": "Santacruz West",
  "santacruz east": "Santacruz East",
  "santa cruz east": "Santacruz East",
  "vidyavihar": "Santacruz East",
  "kurla camp": "Santacruz East",
  "kalina": "Santacruz East",
  "andheri west": "Andheri West",
  "andheri w": "Andheri West",
  "lokhandwala": "Andheri West",
  "lokhandwala complex": "Andheri West",
  "versova": "Andheri West",
  "oshiwara": "Andheri West",
  "yari road": "Andheri West",
  "yari rd": "Andheri West",
  "mhada": "Andheri West",
  "irla": "Andheri West",
  "seven bungalows": "Andheri West",
  "7 bungalows": "Andheri West",
  "jp road": "Andheri West",
  "jp rd": "Andheri West",
  "new link road": "Andheri West",
  "new link rd": "Andheri West",
  "milan subway": "Andheri West",
  "andheri east": "Andheri East",
  "andheri e": "Andheri East",
  "marol": "Andheri East",
  "chakala": "Andheri East",
  "sahar": "Andheri East",
  "midc": "Andheri East",
  "midc andheri": "Andheri East",
  "saki naka": "Andheri East",
  "saki vihar road": "Andheri East",
  "saki vihar rd": "Andheri East",
  "j b nagar": "Andheri East",
  "mahakali caves": "Andheri East",
  "asalpha": "Andheri East",
  "powai": "Andheri East",
  "chandivali": "Andheri East",
  "hiranandani gardens": "Andheri East",
  "hiranandani": "Andheri East",
  "vile parle": "Vile Parle West",
  "vile parle w": "Vile Parle West",
  "parle west": "Vile Parle West",
  "parle": "Vile Parle West",
  "vile parle east": "Vile Parle East",
  "vile parle e": "Vile Parle East",
  "goregaon west": "Goregaon West",
  "goregaon w": "Goregaon West",
  "aarey colony": "Goregaon West",
  "aarey": "Goregaon West",
  "goregaon east": "Goregaon East",
  "goregaon e": "Goregaon East",
  "jogeshwari east": "Goregaon East",
  "jogeshwari e": "Goregaon East",
  "jogeshwari west": "Goregaon East",
  "jogeshwari w": "Goregaon East",
  "jogeshwari": "Goregaon East",
  "malad west": "Malad West",
  "malad w": "Malad West",
  "marve road": "Malad West",
  "marve rd": "Malad West",
  "orlem": "Malad West",
  "manori": "Malad West",
  "madh island": "Malad West",
  "madh": "Malad West",
  "malad east": "Malad East",
  "malad e": "Malad East",
  "kurar village": "Malad East",
  "kandivali west": "Kandivali West",
  "kandivali w": "Kandivali West",
  "charkop": "Kandivali West",
  "kandivali east": "Kandivali East",
  "kandivali e": "Kandivali East",
  "thakur village": "Kandivali East",
  "borivali west": "Borivali West",
  "borivali w": "Borivali West",
  "ic colony": "Borivali West",
  "borivali east": "Borivali East",
  "borivali e": "Borivali East",
  "dahisar west": "Dahisar",
  "dahisar w": "Dahisar",
  "dahisar east": "Dahisar",
  "dahisar e": "Dahisar",
  "worli": "Worli",
  "worli sea face": "Worli",
  "prabhadevi": "Prabhadevi",
  "lower parel": "Lower Parel",
  "parel": "Parel",
  "elphinstone": "Lower Parel",
  "dadar": "Dadar",
  "dadar west": "Dadar",
  "dadar w": "Dadar",
  "dadar east": "Dadar",
  "dadar e": "Dadar",
  "mahim": "Mahim",
  "mahim west": "Mahim",
  "mahim w": "Mahim",
  "matunga": "Matunga",
  "matunga west": "Matunga",
  "matunga w": "Matunga",
  "matunga east": "Matunga",
  "matunga e": "Matunga",
  "sion": "Sion",
  "chembur": "Chembur",
  "ghatkopar": "Ghatkopar",
  "mulund": "Mulund",
  "mulund west": "Mulund",
  "mulund w": "Mulund",
  "kurla": "Kurla",
  "marine lines": "Marine Lines",
  "churchgate": "Churchgate",
  "colaba": "Colaba",
  "fort": "Fort",
  "cuffe parade": "Cuffe Parade",
  "tardeo": "Tardeo",
  "warden road": "Warden Road",
  "opera house": "Opera House",
  "mahalaxmi": "Mahalaxmi",
  "byculla": "Byculla",
  "nariman point": "Nariman Point",
  "wadala": "Wadala",
  "vashi": "Vashi",
  "nerul": "Nerul",
  "panvel": "Panvel",
  "kharghar": "Kharghar",
  "ghansoli": "Ghansoli",
  "kopar khairane": "Kopar Khairane",
  "ulwe": "Ulwe",
  "cbd belapur": "CBD Belapur",
  "belapur": "CBD Belapur",
  "sanpada": "Sanpada",
  "seawoods": "Seawoods",
  "kamothe": "Kamothe",
  "kalamboli": "Kalamboli",
  "thane": "Thane",
  "thane west": "Thane West",
  "thane w": "Thane West",
  "naupada": "Thane West",
  "pokhran road": "Thane West",
  "pokhran rd": "Thane West",
  "kasarvadavali": "Thane West",
  "majiwada": "Thane West",
  "hiranandani estate": "Thane West",
  "ghodbunder": "Thane West",
  "dombivli": "Dombivli",
  "dombivli east": "Dombivli",
  "dombivli west": "Dombivli",
  "kalyan": "Kalyan",
  "ambernath": "Ambernath",
  "badlapur": "Badlapur",
  "mira road": "Mira Road",
  "bhayandar": "Bhayandar",
  "dahisar": "Dahisar",
  "vasai": "Vasai",
  "virar": "Virar",
  "nallasopara": "Nallasopara"
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

const KNOWN_LOCALITY_LABELS = Array.from(new Set([
  ...Object.values(STANDALONE_LOCALITIES),
  ...Object.values(REDIRECTS),
  ...Object.values(IMPLIED_DIRECTION),
  ...Array.from(GENERIC_PARENTS, (value) => value.replace(/\b\w/g, (letter) => letter.toUpperCase())),
]));

function normalise(raw: string): string {
  // This resolver is used for both stored locality labels ("Bandra West")
  // and dynamic route params ("bandra-west"). Treat slug separators as word
  // separators so every canonical locality survives a label -> slug -> route
  // round trip.
  return (raw ?? "")
    .trim()
    .replace(/[()]/g, " ")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
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

  const referenceLabel = LOCALITY_REFERENCE_CANONICAL[input];
  if (referenceLabel) {
    return {
      label: referenceLabel,
      slug: slugify(referenceLabel),
      public: true,
      standalonePage: Boolean(STANDALONE_LOCALITIES[normalise(referenceLabel)]),
    };
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

/**
 * Return the stored slugs that can represent one public canonical locality.
 *
 * The database column is derived from raw ingestion text, so historical rows
 * may contain `bandra`, `pali-hill`, or `mount-mary` even though the public
 * page is grouped under `bandra-west`. Keep this expansion in the read path
 * until the stored column is rebuilt from the canonical taxonomy.
 */
export function localityQuerySlugs(raw: string): string[] {
  const canonical = canonicalLocality(raw);
  if (!canonical.public || !canonical.slug) return [];

  const slugs = new Set<string>([canonical.slug]);
  for (const value of [
    ...Object.keys(REDIRECTS),
    ...Object.keys(IMPLIED_DIRECTION),
    ...Object.keys(STANDALONE_LOCALITIES),
  ]) {
    const mapped = canonicalLocality(value);
    if (mapped.slug === canonical.slug) slugs.add(slugify(value));
  }
  return Array.from(slugs);
}

/** Historical text labels that may represent one canonical public locality. */
export function localityQueryLabels(raw: string): string[] {
  const canonical = canonicalLocality(raw);
  if (!canonical.public || !canonical.slug) return [];

  const labels = new Set<string>([canonical.label]);
  for (const value of [
    ...Object.keys(REDIRECTS),
    ...Object.keys(IMPLIED_DIRECTION),
    ...Object.keys(STANDALONE_LOCALITIES),
  ]) {
    const mapped = canonicalLocality(value);
    if (mapped.slug === canonical.slug) labels.add(value);
  }
  return Array.from(labels);
}

/** Convenience: is this raw value hidden from public pages? */
export function isHiddenLocality(raw: string | null | undefined): boolean {
  return !canonicalLocality(raw).public;
}

/** Extract the longest reviewed locality phrase embedded in free text. */
export function extractLocalityFromText(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  return KNOWN_LOCALITY_LABELS
    .filter((label) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z])${escaped}(?=$|[^a-z])`, "i").test(text);
    })
    .sort((a, b) => b.length - a.length)[0] ?? null;
}
