import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'AgPal Boardroom',
  description: "The founder's view of an agent-run company.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
