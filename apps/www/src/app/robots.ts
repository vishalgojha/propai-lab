import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    // Keep data-backed routes outside this positioning-only crawl release.
    // These exclusions are crawl hints, never privacy/access controls.
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/listings", "/projects", "/collections", "/localities", "/locations", "/buildings", "/search", "/market", "/map", "/blog", "/data-deletion"],
    },
    sitemap: `${getSiteUrl()}/sitemap.xml`,
  };
}
