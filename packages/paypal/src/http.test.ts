import { describe, expect, it, vi } from 'vitest';
import { Secret } from '@agpal/shared';
import { PayPalError } from './errors.js';
import { PayPalHttp, toRequestId } from './http.js';

const token = () =>
  new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function client(fetchImpl: typeof fetch, maxRetries = 2) {
  return new PayPalHttp({
    baseUrl: 'https://api-m.sandbox.paypal.com',
    clientId: 'id',
    clientSecret: new Secret('shh-secret'),
    timeoutMs: 50,
    maxRetries,
    backoffMs: 1,
    fetch: fetchImpl,
  });
}

describe('PayPalHttp', () => {
  it('sends PayPal-Request-Id on writes and retries 5xx with the same id', async () => {
    const seen: (string | null)[] = [];
    const f = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/v1/oauth2/token') return token();
      seen.push(new Headers(init.headers).get('PayPal-Request-Id'));
      return seen.length < 3 ? json(503, { name: 'SERVICE_UNAVAILABLE' }) : json(201, { ok: true });
    });
    const res = await client(f as unknown as typeof fetch).request(
      'POST',
      '/v1/payments/payouts',
      {},
      { requestId: 'intent-1' },
    );
    expect(res.status).toBe(201);
    const id = toRequestId('intent-1');
    expect(seen).toEqual([id, id, id]);
  });

  it('never retries a POST without an idempotency key', async () => {
    let calls = 0;
    const f = vi.fn(async (url: URL) => {
      if (url.pathname === '/v1/oauth2/token') return token();
      calls++;
      return json(503, {});
    });
    await expect(
      client(f as unknown as typeof fetch).request('POST', '/x', {}),
    ).rejects.toBeInstanceOf(PayPalError);
    expect(calls).toBe(1);
  });

  it('does not retry 4xx and surfaces PayPal error details', async () => {
    let calls = 0;
    const f = vi.fn(async (url: URL) => {
      if (url.pathname === '/v1/oauth2/token') return token();
      calls++;
      return json(422, {
        name: 'UNPROCESSABLE_ENTITY',
        debug_id: 'dbg1',
        details: [{ issue: 'CAPTURE_FULLY_REFUNDED', description: 'Already refunded' }],
      });
    });
    const err = await client(f as unknown as typeof fetch)
      .request('POST', '/x', {}, { requestId: 'k' })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 422,
      issue: 'CAPTURE_FULLY_REFUNDED',
      debugId: 'dbg1',
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it('times out each attempt and retries idempotent GETs', async () => {
    let calls = 0;
    const f = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.pathname === '/v1/oauth2/token') return token();
      calls++;
      if (calls < 2) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('timed out', 'TimeoutError')),
          );
        });
      }
      return json(200, { ok: 1 });
    });
    const res = await client(f as unknown as typeof fetch).request(
      'GET',
      '/v1/payments/payouts/B1',
    );
    expect(res.data).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it('refreshes the token once on 401 and never puts the secret in errors', async () => {
    let tokens = 0;
    let calls = 0;
    const f = vi.fn(async (url: URL) => {
      if (url.pathname === '/v1/oauth2/token') {
        tokens++;
        return token();
      }
      calls++;
      return calls === 1 ? json(401, { error: 'invalid_token' }) : json(200, {});
    });
    await client(f as unknown as typeof fetch).request('GET', '/x');
    expect(tokens).toBe(2);
    const bad = vi.fn(async () => json(401, { error: 'invalid_client' }));
    const err = await client(bad as unknown as typeof fetch)
      .request('GET', '/x')
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('shh-secret');
  });

  it('caches the token across concurrent calls', async () => {
    let tokens = 0;
    const f = vi.fn(async (url: URL) => {
      if (url.pathname === '/v1/oauth2/token') {
        tokens++;
        return token();
      }
      return json(200, {});
    });
    const c = client(f as unknown as typeof fetch);
    await Promise.all([c.request('GET', '/a'), c.request('GET', '/b'), c.request('GET', '/c')]);
    expect(tokens).toBe(1);
  });
});

describe('toRequestId', () => {
  it('is deterministic, UUID-shaped and passes UUIDs through', () => {
    const a = toRequestId(
      'cardsale:co_0123456789abcdef0123456789abcdef:sale_0123456789abcdef0123456789abcdef',
    );
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(
      toRequestId(
        'cardsale:co_0123456789abcdef0123456789abcdef:sale_0123456789abcdef0123456789abcdef',
      ),
    ).toBe(a);
    expect(toRequestId('other')).not.toBe(a);
    const u = '3b241101-e2bb-4255-8caf-4136c566a962';
    expect(toRequestId(u)).toBe(u);
  });
});
