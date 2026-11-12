import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact HMAC-signed tokens for founder login links and session cookies: base64url(JSON payload).base64url(HMAC).
 * The secret comes from env (AGPAL_SESSION_SECRET) and never leaves the server.
 */
export interface TokenPayload {
  sub: string;
  kind: 'login' | 'session';
  /** Expiry, seconds since epoch. */
  exp: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const mac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest();

export function signToken(secret: string, payload: TokenPayload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, body))}`;
}

export function verifyToken(
  secret: string,
  token: string,
  kind: TokenPayload['kind'],
  now = Date.now(),
): TokenPayload | undefined {
  const [body, sig] = token.split('.');
  if (!body || !sig) return undefined;
  const expected = mac(secret, body);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (p.kind !== kind || typeof p.exp !== 'number' || p.exp * 1000 < now) return undefined;
    return p;
  } catch {
    return undefined;
  }
}
