import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AEGIS Dashboard',
  description: 'API Gateway Observability Dashboard',
  icons: {
    icon: '/favicon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body className="bg-[#0a0f1a] text-white min-h-screen">
        {children}
      </body>
    </html>
  );
}
