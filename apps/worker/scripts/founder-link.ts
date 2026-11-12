/**
 * pnpm founder:link — print a one-click founder sign-in link for the boardroom (valid 15 minutes).
 * Signed with AGPAL_SESSION_SECRET; set WEB_URL for a deployed boardroom (default http://localhost:3000).
 */
import { loadEnv, signToken } from '@agpal/shared';

const env = loadEnv();
if (!env.AGPAL_SESSION_SECRET) throw new Error('AGPAL_SESSION_SECRET is not set');
const token = signToken(env.AGPAL_SESSION_SECRET.reveal(), {
  sub: 'founder',
  kind: 'login',
  exp: Math.floor(Date.now() / 1000) + 15 * 60,
});
console.log(`${process.env.WEB_URL ?? 'http://localhost:3000'}/login?token=${token}`);
