import 'server-only';
import { cookies } from 'next/headers';
import { signToken, verifyToken } from '@agpal/shared';

/** Server-side only: the API URL and admin token never reach the browser. */
// Render private network: AGPAL_API_HOSTPORT (host:port of agpal-api); locally AGPAL_API_URL or localhost.
const API_URL =
  process.env.AGPAL_API_URL ??
  (process.env.AGPAL_API_HOSTPORT
    ? `http://${process.env.AGPAL_API_HOSTPORT}`
    : 'http://localhost:4000');
const SESSION_COOKIE = 'agpal_session';
const SESSION_SECONDS = 12 * 3600;

const secret = (): string | undefined => process.env.AGPAL_SESSION_SECRET;

export async function isFounder(): Promise<boolean> {
  const s = secret();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return Boolean(s && token && verifyToken(s, token, 'session')?.sub === 'founder');
}

/** Exchange a one-time-use-window login link token for a session cookie. */
export async function startSession(loginToken: string): Promise<boolean> {
  const s = secret();
  if (!s || verifyToken(s, loginToken, 'login')?.sub !== 'founder') return false;
  const session = signToken(s, {
    sub: 'founder',
    kind: 'session',
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  });
  (await cookies()).set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  });
  return true;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!(await isFounder())) throw new Error('not signed in');
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'x-agpal-admin': process.env.AGPAL_ADMIN_TOKEN ?? '',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}
