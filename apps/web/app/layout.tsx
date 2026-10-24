import type { Metadata, Viewport } from 'next';
import { Geist_Mono, Inter, Poppins } from 'next/font/google';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/AppShell';
import './globals.css';

// Self-hosted at build time by next/font: the browser never contacts Google.
const sans = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const label = Poppins({ subsets: ['latin'], weight: '600', variable: '--font-poppins', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Silicr · private GPU market on Zcash', template: '%s · Silicr' },
  description:
    'Rent GPUs with sealed RFQs, signed bids and per-interval shielded ZEC payments. The Leak Inspector shows what every party actually learned.',
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${label.variable} ${mono.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
