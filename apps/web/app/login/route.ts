import { NextResponse, type NextRequest } from 'next/server';
import { startSession } from '../../lib/server';

/**
 * Behind a proxy (Render), `req.url` is the internal address (localhost:10000); redirect to the public origin the
 * browser used, from the forwarded headers.
 */
function publicUrl(req: NextRequest, path: string): URL {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  return new URL(path, host ? `${proto}://${host}` : req.url);
}

/** Founder magic link: /login?token=… (minted by `pnpm founder:link`, valid 15 minutes). */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const ok = await startSession(token);
  return NextResponse.redirect(publicUrl(req, ok ? '/overview' : '/?login=failed'));
}
