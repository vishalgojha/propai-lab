import type { MetadataRoute } from "next";
import { getAllLocalities, getAllBuildings } from "@/lib/localities";
import { slugify } from "@/lib/supabase";
import { getSiteUrl } from "@/lib/site";

// Programmatic sub-page segments emitted per locality (mirrors the
// [segment] route decoder in localities/[slug]/[segment]/page.tsx).
const TXN_SEGMENTS = ["sale", "rent", "commercial"] as const;
const BHK_SEGMENTS = [1, 2, 3, 4, 5];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = getSiteUrl();
  const localities = await getAllLocalities();
  const buildings = await getAllBuildings(5000);

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

  return urls;
}
