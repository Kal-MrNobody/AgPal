import Link from 'next/link';
import type { ReactNode } from 'react';
import { isFounder } from '../../lib/server';
import { EXTRA_PAGES, PAGES } from '../../lib/types';

export const dynamic = 'force-dynamic';

export default async function BoardLayout({ children }: { children: ReactNode }) {
  if (!(await isFounder())) {
    return (
      <main className="signin">
        <h1>AgPal Boardroom</h1>
        <p>
          This is the founder&apos;s view. Open the sign-in link from <code>pnpm founder:link</code>{' '}
          (valid 15 minutes).
        </p>
      </main>
    );
  }
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">AgPal</div>
        {[...PAGES, ...EXTRA_PAGES].map((p) => (
          <Link key={p.id} href={`/${p.id}`} className="navlink">
            {p.title}
          </Link>
        ))}
      </nav>
      <section className="content">{children}</section>
    </div>
  );
}
