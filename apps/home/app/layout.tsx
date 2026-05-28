import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

// Brand typeface (Inter) exposed as --font-brand; the warm palette + the rest of the
// vertical identity live in app config (whitelabel) + globals.css (ADR-0021).
const inter = Inter({ subsets: ['latin'], variable: '--font-brand', display: 'swap' });

export const metadata: Metadata = {
  title: 'Impact — your community portal',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
