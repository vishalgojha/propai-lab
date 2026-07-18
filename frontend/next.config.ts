import type { NextConfig } from "next";

const configuredApiBase = process.env.LAB_API_BASE_URL || "http://localhost:8000";
const API_BASE = configuredApiBase;

const nextConfig: NextConfig = {
  typescript: { ignoreBuildErrors: true },
  async rewrites() {
    return [
      {
        source: "/api/chat",
        destination: "/api/chat",
      },
      {
        source: "/api/:path*",
        destination: `${API_BASE}/api/:path*`,
      },
      {
        source: "/manifest",
        destination: "/manifest.json",
      },
    ];
  },
  async headers() {
    return [
      {
        // The authenticated app shell contains deployment-specific chunk URLs and
        // user-specific navigation. Never let the CDN retain it across releases.
        // Hashed Next assets, API routes and public files are excluded below.
        source: "/((?!api(?:/|$)|_next(?:/|$)|sw\\.js$|manifest\\.json$|.*\\.[^/]+$).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "private, no-store, no-cache, must-revalidate, max-age=0",
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.json",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          { key: "Content-Type", value: "application/manifest+json" },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
