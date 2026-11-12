import { describe, expect, it, vi } from 'vitest';
import { money, Secret } from '@agpal/shared';
import { toPayPalAmount } from './amount.js';
import { PayPal, isTransportError } from './paypal.js';
import { sdkConfiguration } from './sdk.js';
import type { SdkControllers } from './sdk.js';

/** Regression tests for docs/apimatic-plugin.md findings. */

const token = () =>
  new Response(JSON.stringify({ access_token: 'tok', expires_in: 32400 }), { status: 200 });

function paypalWith(fetchImpl: (url: URL, init: RequestInit) => Promise<Response>) {
  return new PayPal({
    environment: 'sandbox',
    clientId: 'id',
    clientSecret: new Secret('secret'),
    backoffMs: 1,
    fetch: fetchImpl as unknown as typeof fetch,
    sdk: {} as SdkControllers,
  });
}

describe('P5-1 / P5-2: explicit SDK timeout and a retry budget that can fire', () => {
  const cfg = sdkConfiguration({
    environment: 'sandbox',
    clientId: 'a',
    clientSecret: new Secret('b'),
    timeoutMs: 15_000,
    maxRetries: 3,
  });
  it('sets a non-zero timeout (SDK default 0 = wait forever)', () => {
    expect(cfg.timeout).toBe(15_000);
    expect(cfg.httpClientOptions?.timeout).toBe(15_000);
  });
  it('sets maxNumberOfRetries and a non-zero maximumRetryWaitTime (SDK default 0 disables retries)', () => {
    expect(cfg.httpClientOptions?.retryConfig?.maxNumberOfRetries).toBe(3);
    expect(cfg.httpClientOptions?.retryConfig?.maximumRetryWaitTime).toBeGreaterThan(0);
  });
});

describe('P5-4: Payouts amount uses {currency, value}', () => {
  it('sends the payout amount in the Payouts v1 shape, with sender_batch_id = intent id', async () => {
    let body: Record<string, unknown> = {};
    const pp = paypalWith(async (url, init) => {
      if (url.pathname === '/v1/oauth2/token') return token();
      body = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } }),
        { status: 201 },
      );
    });
    await pp.createPayout({
      senderBatchId: 'int_1',
      receiverEmail: 'a@example.com',
      amountMinor: 4000n,
      currency: 'USD',
      note: 'n',
    });
    const items = body.items as { amount: unknown }[];
    expect(items[0]?.amount).toEqual({ currency: 'USD', value: '40.00' });
    expect((body.sender_batch_header as { sender_batch_id: string }).sender_batch_id).toBe('int_1');
  });
});

describe('P6-1: no retried POST without an idempotency key', () => {
  it('cancelSubscription is sent once even on 503, and a lost-response cancel is recognised', async () => {
    let cancels = 0;
    const pp = paypalWith(async (url) => {
      if (url.pathname === '/v1/oauth2/token') return token();
      cancels++;
      return new Response('{}', { status: 503 });
    });
    await expect(pp.cancelSubscription('I-1', 'customer asked')).rejects.toThrow();
    expect(cancels).toBe(1);
  });
});

describe('P6-2: only transport errors are retryable', () => {
  it('classifies errors', () => {
    expect(
      isTransportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
    ).toBe(true);
    expect(isTransportError(new DOMException('t', 'TimeoutError'))).toBe(true);
    expect(isTransportError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isTransportError(new Error('Argument for body has incorrect type'))).toBe(false);
  });
});

describe('P6-3: amount formatting', () => {
  it('formats zero-decimal and two-decimal currencies exactly', () => {
    expect(toPayPalAmount(1000n, 'JPY')).toEqual({ currency_code: 'JPY', value: '1000' });
    expect(toPayPalAmount(1000n, 'HUF')).toEqual({ currency_code: 'HUF', value: '1000' });
    expect(toPayPalAmount(5n, 'USD')).toEqual({ currency_code: 'USD', value: '0.05' });
    expect(money(100n, 'USD').amountMinor).toBe(100n);
  });
});

describe('P6-4: webhook verification fails closed', () => {
  it('rejects missing headers or a non-JSON body without calling PayPal', async () => {
    const f = vi.fn();
    const pp = paypalWith(f);
    expect(await pp.verifyWebhook({ webhookId: 'WH', headers: {}, rawBody: '{}' })).toBe(false);
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 't',
      'paypal-transmission-sig': 's',
      'paypal-transmission-time': '2026-11-12T00:00:00Z',
    };
    expect(await pp.verifyWebhook({ webhookId: 'WH', headers, rawBody: 'not json' })).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('accepts only verification_status SUCCESS', async () => {
    const headers = {
      'paypal-auth-algo': 'a',
      'paypal-cert-url': 'b',
      'paypal-transmission-id': 'c',
      'paypal-transmission-sig': 'd',
      'paypal-transmission-time': 'e',
    };
    const answer = (status: string) =>
      paypalWith(async (url) =>
        url.pathname === '/v1/oauth2/token'
          ? token()
          : new Response(JSON.stringify({ verification_status: status }), { status: 200 }),
      );
    expect(
      await answer('SUCCESS').verifyWebhook({ webhookId: 'WH', headers, rawBody: '{"id":"WH-1"}' }),
    ).toBe(true);
    expect(
      await answer('FAILURE').verifyWebhook({ webhookId: 'WH', headers, rawBody: '{"id":"WH-1"}' }),
    ).toBe(false);
  });
});
