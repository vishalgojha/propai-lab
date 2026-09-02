import type { Metadata, Viewport } from 'next';
import './globals.css';
import './public-theme.css';
import { getSiteUrl } from '@/lib/site';
import { JsonLd, buildOrganization, buildWebSite } from '@/lib/seo';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister';

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: 'PropAI — Find Property Through Verified Brokers',
  description: 'Search verified residential and commercial property listings from WhatsApp broker networks. Real listings, real brokers, real freshness.',
  icons: {
    icon: [
      { url: '/propai-logo.svg?v=3', type: 'image/svg+xml' },
      { url: '/favicon.svg?v=3', type: 'image/svg+xml' },
    ],
    apple: '/propai-logo.svg?v=3',
  },
  openGraph: {
    title: 'PropAI — Find Property Through Verified Brokers',
    description: 'Search verified residential and commercial property listings from WhatsApp broker networks.',
    type: 'website',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'PropAI — Mumbai property listings from brokers' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PropAI — Find Property Through Verified Brokers',
    description: 'Search verified residential and commercial property listings from WhatsApp broker networks.',
    images: ['/opengraph-image'],
  },
  robots: 'index, follow',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
  statusBarStyle: 'default',
    title: 'PropAI',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#12211A',
};

export default function WWWLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="antialiased" data-theme="light">
      <body className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
        <ServiceWorkerRegister />
        {children}
        <JsonLd data={buildOrganization({ url: getSiteUrl() })} />
        <JsonLd data={buildWebSite(getSiteUrl())} />
      </body>
    </html>
  );
}
