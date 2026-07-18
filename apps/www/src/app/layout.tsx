import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { getSiteUrl } from '@/lib/site';
import { JsonLd, buildOrganization, buildWebSite } from '@/lib/seo';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

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
  themeColor: '#000000',
};

export default function WWWLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} antialiased`}>
      <body className="bg-black text-white font-sans min-h-screen">
        {children}
        <JsonLd data={buildOrganization({ url: getSiteUrl() })} />
        <JsonLd data={buildWebSite(getSiteUrl())} />
      </body>
    </html>
  );
}
