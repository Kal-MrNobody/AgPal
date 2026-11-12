import { NextResponse, type NextRequest } from 'next/server';
import { startSession } from '../../lib/server';

/** Founder magic link: /login?token=… (minted by `pnpm founder:link`, valid 15 minutes). */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const ok = await startSession(token);
  return NextResponse.redirect(new URL(ok ? '/overview' : '/?login=failed', req.url));
}
