import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'OmniOS — Operations Console',
  description: 'Projects, agents, jobs, approvals, audit.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-base font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
