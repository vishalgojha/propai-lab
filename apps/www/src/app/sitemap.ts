import type { MetadataRoute } from "next";
import { getAllLocalities, getAllBuildings, getRecentListingsForSitemap } from "@/lib/localities";
import { slugify } from "@/lib/supabase";
import { getSiteUrl } from "@/lib/site";
import { buildListingSlug } from "@/lib/listing-card";

// Programmatic sub-page segments emitted per locality (mirrors the
// [segment] route decoder in localities/[slug]/[segment]/page.tsx).
const TXN_SEGMENTS = ["sale", "rent", "commercial"] as const;
const BHK_SEGMENTS = [1, 2, 3, 4, 5];

// Hard cap on total sitemap entries. Google rejects sitemaps > 50k URLs;
// stay well under that with a generous headroom.
const SITEMAP_CAP = 49_000;
// Listings freshness window: dead listings are pruned so Google doesn't
// waste crawl budget on rows that have aged out of the live inventory.
const LISTING_FRESHNESS_DAYS = 90;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getSiteUrl();
  const localities = await getAllLocalities();
  const buildings = await getAllBuildings(5000);
  const listings = await getRecentListingsForSitemap({
    sinceDays: LISTING_FRESHNESS_DAYS,
    limit: 10_000,
  });

  const now = new Date();
  const urls: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${baseUrl}/search`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.95,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/contact`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/localities`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${baseUrl}/buildings`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
  ];

  for (const locality of localities.slice(0, 5000)) {
    // Base locality page.
    urls.push({
      url: `${baseUrl}/localities/${locality.slug}`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.75,
    });
    // Programmatic sub-pages (sale / rent / commercial / bhk-N).
    for (const seg of TXN_SEGMENTS) {
      urls.push({
        url: `${baseUrl}/localities/${locality.slug}/${seg}`,
        lastModified: now,
        changeFrequency: "daily",
        priority: 0.7,
      });
    }
    for (const bhk of BHK_SEGMENTS) {
      urls.push({
        url: `${baseUrl}/localities/${locality.slug}/bhk-${bhk}`,
        lastModified: now,
        changeFrequency: "daily",
        priority: 0.65,
      });
    }
  }

  // Building detail pages.
  for (const b of buildings.slice(0, 5000)) {
    const slug = slugify(b.name);
    if (!slug) continue;
    urls.push({
      url: `${baseUrl}/buildings/${slug}`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.6,
    });
  }

  // Listing detail pages. Use the same SEO slug the public detail page
  // renders so the URLs Google sees in the sitemap match what users hit.
  for (const l of listings) {
    const slug = buildListingSlug({
      id: l.id,
      bhk: l.bhk,
      micro_market: l.micro_market,
      building_name: l.building_name,
      property_type: l.property_type,
    });
    if (!slug) continue;
    const lastModified = l.last_seen ? new Date(l.last_seen) : now;
    urls.push({
      url: `${baseUrl}/listings/${slug}`,
      lastModified,
      changeFrequency: "daily",
      priority: 0.55,
    });
  }

  // Defensive cap. If we somehow exceeded the cap (e.g. locality rows
  // exploded), truncate and warn so we don't ship a sitemap Google rejects.
  if (urls.length > SITEMAP_CAP) {
    console.warn(`sitemap: truncating to ${SITEMAP_CAP} entries (was ${urls.length})`);
    return urls.slice(0, SITEMAP_CAP);
  }
  return urls;
}
