import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'PropAI — Find Your Home Through Verified Brokers',
  description: 'Search verified property listings from WhatsApp broker networks. Real listings, real brokers, real freshness.',
  openGraph: {
    title: 'PropAI — Find Your Home Through Verified Brokers',
    description: 'Search verified property listings from WhatsApp broker networks.',
    type: 'website',
  },
  robots: 'index, follow',
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
      </body>
    </html>
  );
}