import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Inter, Poppins } from 'next/font/google';
import type { ReactNode } from 'react';
import { SITE_URL } from '@/lib/config';
import './globals.css';
import './motion.css';

// Self-hosted at build time by next/font: the browser never contacts Google.
const sans = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const display = Poppins({ subsets: ['latin'], weight: '600', variable: '--font-poppins', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

const TITLE = 'Silicr · Rent a GPU without telling the world';
const DESCRIPTION =
  'A private GPU-compute market on Zcash: sealed requests, signed bids and pay-per-interval in shielded ZEC. No server in the middle reads your order.';

// Social images need absolute URLs, so they are only emitted when the public site URL is known.
const ogImage = SITE_URL
  ? [{ url: '/og.png', width: 1200, height: 630, alt: 'Silicr: the same Zcash transaction as the public chain sees it and as the buyer sees it' }]
  : undefined;

export const metadata: Metadata = {
  ...(SITE_URL ? { metadataBase: new URL(SITE_URL) } : {}),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'Silicr',
  openGraph: {
    type: 'website',
    siteName: 'Silicr',
    title: TITLE,
    description: DESCRIPTION,
    ...(SITE_URL ? { url: '/' } : {}),
    ...(ogImage ? { images: ogImage } : {}),
  },
  twitter: {
    card: ogImage ? 'summary_large_image' : 'summary',
    title: TITLE,
    description: DESCRIPTION,
    ...(ogImage ? { images: ogImage.map((i) => i.url) } : {}),
  },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body>
        <a
          href="#main"
          className="sr-only rounded-full bg-white font-semibold text-black focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[60] focus:px-4 focus:py-2"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
