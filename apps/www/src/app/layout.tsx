import type { Metadata, Viewport } from 'next';
import './globals.css';
import { getSiteUrl } from '@/lib/site';
import { JsonLd, buildOrganization, buildWebSite } from '@/lib/seo';

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: 'PropAI — Find Property Through Verified Brokers',
  description: 'Search verified residential and commercial property listings from WhatsApp broker networks. Real listings, real brokers, real freshness.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico' },
    ],
    apple: '/favicon.svg',
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
    statusBarStyle: 'black-translucent',
    title: 'PropAI',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#f4f1ea',
};

export default function WWWLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="antialiased">
      <body className="bg-black text-white font-sans min-h-screen">
        {children}
        <JsonLd data={buildOrganization({ url: getSiteUrl() })} />
        <JsonLd data={buildWebSite(getSiteUrl())} />
      </body>
    </html>
  );
}
