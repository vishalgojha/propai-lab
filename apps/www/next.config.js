/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // WWW is a fully separate app from app.propai.live
  // Static export for SSG/ISR of locality and building pages
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // Preserve URLs that were indexed before the public site standardized on
  // `/localities`. Google and old broker shares still use `/locations`.
  async redirects() {
    return [
      {
        source: '/locations/:slug/:segment',
        destination: '/localities/:slug/:segment',
        permanent: true,
      },
      {
        source: '/locations/:slug',
        destination: '/localities/:slug',
        permanent: true,
      },
    ]
  },
  // Allow www to be served at root, with /localities/[slug] and /buildings/[slug]
  async rewrites() {
    return []
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/manifest.webmanifest',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=3600, must-revalidate' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
