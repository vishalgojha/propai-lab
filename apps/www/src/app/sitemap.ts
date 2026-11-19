import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site";

// Publish only stable public site pages here. Do not turn private inventory,
// search results, or broker records into crawl targets through this sitemap.
export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getSiteUrl();
  return ["", "/about", "/contact", "/privacy-policy", "/terms-of-service"].map((path) => ({
    url: `${baseUrl}${path}`,
    changeFrequency: "monthly",
    priority: path === "" ? 1 : 0.6,
  }));
}
