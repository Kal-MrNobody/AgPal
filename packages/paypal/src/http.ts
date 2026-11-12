import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Secret } from '@agpal/shared';
import { fromErrorBody, PayPalError, RETRYABLE_STATUS } from './errors.js';

export interface HttpOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: Secret;
  /** Per attempt, ms. */
  timeoutMs: number;
  /** Extra attempts after the first. */
  maxRetries: number;
  /** Base backoff, ms; doubles per attempt with jitter. */
  backoffMs: number;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Required for every POST that creates or moves something (invariant 4). */
  requestId?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
}

/**
 * Thin typed REST client for PayPal APIs the Server SDK does not cover (Catalog, Invoicing, Payouts,
 * Disputes, webhook verification). Same rules as the SDK client: explicit timeout and retry budget,
 * PayPal-Request-Id on writes, never logs secrets or tokens.
 *
 * Retries: GET/PUT/DELETE always (idempotent); POST/PATCH only when a PayPal-Request-Id is sent, because
 * PayPal then de-duplicates the request.
 */
export class PayPalHttp {
  private token: { value: string; expiresAt: number } | undefined;
  private tokenInFlight: Promise<string> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    this.tokenInFlight ??= this.fetchToken().finally(() => {
      this.tokenInFlight = undefined;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret.reveal()}`).toString(
      'base64',
    );
    const res = await this.send('POST', '/v1/oauth2/token', {
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      rawBody: 'grant_type=client_credentials',
      retryable: true,
    });
    const body = res.json as { access_token?: string; expires_in?: number };
    if (!body.access_token)
      throw new PayPalError(
        'PayPal token response had no access_token',
        res.status,
        undefined,
        undefined,
        false,
      );
    // Refresh 5 minutes early.
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 0) - 300) * 1000,
    };
    return body.access_token;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed view of a JSON body
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const write = method === 'POST' || method === 'PATCH';
    const retryable = !write || Boolean(options.requestId);
    let refreshed = false;
    for (;;) {
      const token = await this.accessToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(options.requestId ? { 'PayPal-Request-Id': toRequestId(options.requestId) } : {}),
        ...options.headers,
      };
      try {
        const res = await this.send(method, path, {
          headers,
          ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }),
          retryable,
          ...(options.query ? { query: options.query } : {}),
        });
        return { status: res.status, data: res.json as T, headers: res.headers };
      } catch (e) {
        // One forced token refresh on 401 (expired or revoked token).
        if (e instanceof PayPalError && e.status === 401 && !refreshed) {
          this.token = undefined;
          refreshed = true;
          continue;
        }
        throw e;
      }
    }
  }

  private async send(
    method: string,
    path: string,
    init: {
      headers: Record<string, string>;
      rawBody?: string;
      retryable: boolean;
      query?: RequestOptions['query'];
    },
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(init.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const attempts = init.retryable ? this.opts.maxRetries + 1 : 1;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(this.backoff(attempt));
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: init.headers,
          ...(init.rawBody === undefined ? {} : { body: init.rawBody }),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const text = await res.text();
        const json: unknown = text ? safeJson(text) : {};
        if (res.ok) return { status: res.status, json, headers: res.headers };
        const err = fromErrorBody(res.status, json, res.statusText);
        if (!RETRYABLE_STATUS.has(res.status)) throw err;
        last = err;
      } catch (e) {
        if (e instanceof PayPalError && !e.retryable) throw e;
        last = e instanceof PayPalError ? e : networkError(e);
      }
    }
    throw last instanceof PayPalError ? last : networkError(last);
  }

  private backoff(attempt: number): number {
    const base = this.opts.backoffMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * base * 0.2);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function networkError(e: unknown): PayPalError {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : 'network error';
  return new PayPalError(`PayPal request failed: ${msg}`, undefined, 'NETWORK', undefined, true);
}

export const newRequestId = (): string => randomUUID();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map any idempotency key to a PayPal-Request-Id PayPal accepts. Orders rejected an 82-character key with
 * colons with a bare 422 UNPROCESSABLE_ENTITY (docs/apimatic-plugin.md, finding P5-5), so keys that are not
 * already UUIDs are hashed into a deterministic UUID-shaped id: the same key always maps to the same id, so
 * retries stay idempotent.
 */
export function toRequestId(key: string): string {
  if (UUID.test(key)) return key;
  const h = createHash('sha256').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
