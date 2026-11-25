import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeSync } from '../hooks/theme.hook.ts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Silo', template: '%s · Silo' },
  description: 'Silo',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
