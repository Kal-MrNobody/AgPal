import { describe, expect, it } from 'vitest';
import { signToken, verifyToken } from './token.js';

describe('signed tokens', () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  it('round-trips and checks kind, expiry and signature', () => {
    const t = signToken('s3cret', { sub: 'founder', kind: 'login', exp });
    expect(verifyToken('s3cret', t, 'login')?.sub).toBe('founder');
    expect(verifyToken('s3cret', t, 'session')).toBeUndefined();
    expect(verifyToken('other', t, 'login')).toBeUndefined();
    expect(verifyToken('s3cret', t, 'login', (exp + 1) * 1000)).toBeUndefined();
    const [body] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ sub: 'founder', kind: 'login', exp: exp + 9999 })).toString('base64url')}.${t.split('.')[1] ?? ''}`;
    expect(body).toBeTruthy();
    expect(verifyToken('s3cret', forged, 'login')).toBeUndefined();
  });
});
