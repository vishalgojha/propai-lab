import type { MetadataRoute } from "next";
import { getAllLocalities, getAllBuildings, getRecentListingsForSitemap } from "@/lib/localities";
import { getProjectsForSitemap } from "@/lib/projects";
import { slugify } from "@/lib/supabase";
import { getSiteUrl } from "@/lib/site";
import { buildListingSlug } from "@/lib/listing-card";

// Sitemap contents come from live Supabase inventory. Generate it when the
// running service is requested, not while Coolify is building the image.
export const dynamic = "force-dynamic";

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
  const projects = await getProjectsForSitemap();

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

  for (const project of projects) {
    if (!project.locality || !project.slug) continue;
    const lastModified = project.last_activity_changed_at || project.last_fact_changed_at || project.last_crawled_at || now;
    urls.push({
      url: `${baseUrl}/projects/${slugify(project.locality)}/${project.slug}`,
      lastModified: new Date(lastModified),
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
      intent: l.intent,
      title: l.title,
    });
    if (!slug) continue;
    const entry: MetadataRoute.Sitemap[number] = {
      url: `${baseUrl}/listings/${slug}/${l.id}`,
      changeFrequency: "daily",
      priority: 0.55,
    };
    // The query is already restricted to rows with a real last_seen value.
    // Never substitute request/build time: that would publish a false
    // freshness signal to crawlers.
    if (l.last_seen && Number.isFinite(new Date(l.last_seen).getTime())) {
      entry.lastModified = new Date(l.last_seen);
    }
    urls.push(entry);
  }

  // Defensive cap. If we somehow exceeded the cap (e.g. locality rows
  // exploded), truncate and warn so we don't ship a sitemap Google rejects.
  if (urls.length > SITEMAP_CAP) {
    console.warn(`sitemap: truncating to ${SITEMAP_CAP} entries (was ${urls.length})`);
    return urls.slice(0, SITEMAP_CAP);
  }
  return urls;
}
