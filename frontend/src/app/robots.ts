import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  // Crawlers must be able to read the app's sitewide noindex response header.
  // This is not an access-control rule; authentication stays unchanged.
  return { rules: { userAgent: "*", allow: "/", disallow: "/api/" } };
}
