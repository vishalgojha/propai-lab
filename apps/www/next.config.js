/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // WWW is a fully separate app from app.propai.live
  // Static export for SSG/ISR of locality and building pages
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  // Allow www to be served at root, with /localities/[slug] and /buildings/[slug]
  async rewrites() {
    return []
  },
}

module.exports = nextConfig