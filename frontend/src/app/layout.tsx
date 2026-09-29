import type { Metadata } from 'next';
import './globals.css';
import { Web3Provider } from '../context/Web3Context';

export const metadata: Metadata = {
  title: 'Contingent — Confidential Event Hedging',
  description:
    'Privately hedge event risk — priced by a prediction market, encrypted with Fhenix, settled in USDG on Arbitrum.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
