import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import type { WebhookDeps } from './webhooks.js';

function harness(verifyResult = true) {
  const stored = new Map<string, unknown>();
  const enqueued: string[] = [];
  const bodies: string[] = [];
  const deps: WebhookDeps = {
    verify: async (_h, raw) => {
      bodies.push(raw);
      return verifyResult;
    },
    store: async (e) => {
      if (stored.has(e.id)) return false;
      stored.set(e.id, e);
      return true;
    },
    enqueue: async (id) => {
      enqueued.push(id);
    },
  };
  return { app: buildServer({ logLevel: 'silent', webhooks: deps }), stored, enqueued, bodies };
}

// Odd spacing on purpose: verification must see these exact bytes.
const raw = '{"id":"WH-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"CAP-1"}}';

describe('POST /webhooks/paypal', () => {
  it('verifies against the exact raw body, stores, enqueues and returns 200', async () => {
    const h = harness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhooks/paypal',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(h.bodies[0]).toBe(raw);
    expect(h.enqueued).toEqual(['WH-1']);
  });

  it('dedupes by event id: a redelivery is 200 but not re-enqueued', async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) {
      await h.app.inject({
        method: 'POST',
        url: '/webhooks/paypal',
        headers: { 'content-type': 'application/json' },
        payload: raw,
      });
    }
    expect(h.enqueued).toEqual(['WH-1']);
  });

  it('rejects unverified events without storing them', async () => {
    const h = harness(false);
    const res = await h.app.inject({
      method: 'POST',
      url: '/webhooks/paypal',
      headers: { 'content-type': 'application/json' },
      payload: raw,
    });
    expect(res.statusCode).toBe(400);
    expect(h.stored.size).toBe(0);
  });

  it('rejects malformed bodies', async () => {
    const h = harness();
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/webhooks/paypal',
          headers: { 'content-type': 'application/json' },
          payload: 'nope',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/webhooks/paypal',
          headers: { 'content-type': 'application/json' },
          payload: '{"x":1}',
        })
      ).statusCode,
    ).toBe(400);
  });
});
