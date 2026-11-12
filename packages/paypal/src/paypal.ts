import {
  ApiError,
  ApplicationContextUserAction,
  CheckoutPaymentIntent,
  ExperienceContextShippingPreference,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type Order,
} from '@paypal/paypal-server-sdk';
import { isCurrency, type Currency, type Secret } from '@agpal/shared';
import { requireAmount, fromPayPalAmount, toPayPalAmount } from './amount.js';
import { fromErrorBody, PayPalError } from './errors.js';
import { PayPalHttp, toRequestId, type HttpOptions } from './http.js';
import { createSdk, type SdkControllers } from './sdk.js';
import {
  balanceWire,
  captureWire,
  linkHref,
  orderCaptureWire,
  refundWire,
  searchPage,
  subscriptionFields,
  transactionWire,
} from './typed.js';
import type {
  Balance,
  Capture,
  CreatedOrder,
  Dispute,
  Invoice,
  PayoutBatch,
  PayoutItem,
  Plan,
  Product,
  Refund,
  Subscription,
  TransactionRecord,
} from './types.js';

export const PAYPAL_BASE_URLS = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
} as const;

export type PayPalEnvironment = keyof typeof PAYPAL_BASE_URLS;

export function baseUrlFor(env: PayPalEnvironment): string {
  return PAYPAL_BASE_URLS[env];
}

export interface PayPalOptions {
  environment: PayPalEnvironment;
  clientId: string;
  clientSecret: Secret;
  /** Per attempt. Default 15s. */
  timeoutMs?: number;
  /** Default 3. */
  maxRetries?: number;
  /** Injected for tests (REST client only). */
  fetch?: typeof fetch;
  /** Injected for tests. */
  sdk?: SdkControllers;
  backoffMs?: number;
}

export interface CreateOrderInput {
  amountMinor: bigint;
  currency: Currency;
  description: string;
  /** Our own reference, echoed back on captures and webhooks. */
  customId?: string;
  invoiceId?: string;
  requestId: string;
  returnUrl?: string;
  cancelUrl?: string;
  brandName?: string;
}

/** PayPal sandbox test card for automated captures (sandbox only). */
export interface SandboxCard {
  number: string;
  expiry: string;
  securityCode: string;
  name: string;
}

export const SANDBOX_VISA: SandboxCard = {
  number: '4111111111111111',
  expiry: '2030-12',
  securityCode: '123',
  name: 'AgPal Test Buyer',
};

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
type AmountLike = Parameters<typeof fromPayPalAmount>[0];

function currencyOf(code: unknown): Currency {
  if (typeof code !== 'string' || !isCurrency(code))
    throw new Error(`Unsupported currency ${String(code)}`);
  return code;
}

const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ERR_NETWORK',
  'UND_ERR_SOCKET',
]);

/** Network failures and timeouts: safe to retry with the same idempotency key. */
export function isTransportError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const x = e as Error & { code?: unknown; isAxiosError?: unknown; response?: unknown };
  if (typeof x.code === 'string' && TRANSPORT_CODES.has(x.code)) return true;
  return x.isAxiosError === true && x.response === undefined;
}

/** Map any SDK failure to PayPalError. Narrow on purpose: only ApiError and transport errors are mapped. */
async function sdkCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) {
      let body: unknown = e.result;
      if (body === undefined && typeof e.body === 'string') {
        try {
          body = JSON.parse(e.body);
        } catch {
          body = { message: e.body.slice(0, 300) };
        }
      }
      throw fromErrorBody(e.statusCode, body, what);
    }
    if (isTransportError(e)) {
      const err = e as Error;
      throw new PayPalError(
        `${what} failed: ${err.name}: ${err.message}`,
        undefined,
        'NETWORK',
        undefined,
        true,
      );
    }
    // Anything else (SDK input validation, a bug in our code) is not retryable: retrying a money call on a
    // programming error would keep the hold and loop (audit finding P6-2).
    throw new PayPalError(
      `${what} failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      undefined,
      'CLIENT',
      undefined,
      false,
    );
  }
}

/**
 * The PayPal adapter. The only code in AgPal that talks to PayPal (invariant 1, enforced by ESLint).
 * Server SDK for Orders, Payments, Subscriptions, Transaction Search; thin REST for the rest
 * (docs/decisions.md ADR-009).
 */
export class PayPal {
  readonly http: PayPalHttp;
  private readonly sdk: SdkControllers;

  constructor(private readonly opts: PayPalOptions) {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const maxRetries = opts.maxRetries ?? 3;
    const httpOpts: HttpOptions = {
      baseUrl: baseUrlFor(opts.environment),
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      timeoutMs,
      maxRetries,
      backoffMs: opts.backoffMs ?? 500,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    };
    this.http = new PayPalHttp(httpOpts);
    this.sdk =
      opts.sdk ??
      createSdk({
        environment: opts.environment,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        timeoutMs,
        maxRetries,
      });
  }

  get environment(): PayPalEnvironment {
    return this.opts.environment;
  }

  // ---------------------------------------------------------------- Orders (SDK)

  /** Create a PayPal-wallet order for digital goods: PAY_NOW, NO_SHIPPING, explicit. */
  async createOrder(i: CreateOrderInput): Promise<CreatedOrder> {
    const res = await sdkCall('createOrder', () =>
      this.sdk.orders.createOrder({
        paypalRequestId: toRequestId(i.requestId),
        prefer: 'return=representation',
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              amount: {
                currencyCode: i.currency,
                value: toPayPalAmount(i.amountMinor, i.currency).value,
              },
              description: i.description.slice(0, 127),
              ...(i.customId ? { customId: i.customId } : {}),
              ...(i.invoiceId ? { invoiceId: i.invoiceId } : {}),
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                userAction: PaypalExperienceUserAction.PayNow,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                ...(i.brandName ? { brandName: i.brandName } : {}),
                ...(i.returnUrl ? { returnUrl: i.returnUrl } : {}),
                ...(i.cancelUrl ? { cancelUrl: i.cancelUrl } : {}),
              },
            },
          },
        },
      }),
    );
    const order = res.result;
    const approveUrl = linkHref(order.links, 'payer-action', 'approve');
    return {
      orderId: order.id ?? '',
      status: order.status ?? '',
      ...(approveUrl ? { approveUrl } : {}),
    };
  }

  /**
   * Sandbox-only automation: create an order paid by a test card and captured in one call, so loops and
   * simulations need no browser. Refuses to run against live.
   */
  async createAndCaptureSandboxCardOrder(
    i: CreateOrderInput,
    card: SandboxCard = SANDBOX_VISA,
  ): Promise<Capture> {
    if (this.opts.environment !== 'sandbox') throw new Error('Card automation is sandbox-only');
    const res = await sdkCall('createOrder(card)', () =>
      this.sdk.orders.createOrder({
        paypalRequestId: toRequestId(i.requestId),
        prefer: 'return=representation',
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              amount: {
                currencyCode: i.currency,
                value: toPayPalAmount(i.amountMinor, i.currency).value,
              },
              description: i.description.slice(0, 127),
              ...(i.customId ? { customId: i.customId } : {}),
              ...(i.invoiceId ? { invoiceId: i.invoiceId } : {}),
            },
          ],
          paymentSource: {
            card: {
              number: card.number,
              expiry: card.expiry,
              securityCode: card.securityCode,
              name: card.name,
            },
          },
        },
      }),
    );
    return captureFromTypedOrder(res.result);
  }

  /** Capture an approved order. Idempotent on requestId. */
  async captureOrder(orderId: string, requestId: string): Promise<Capture> {
    const res = await sdkCall('captureOrder', () =>
      this.sdk.orders.captureOrder({
        id: orderId,
        paypalRequestId: toRequestId(requestId),
        prefer: 'return=representation',
      }),
    );
    return captureFromTypedOrder(res.result);
  }

  async getOrder(
    orderId: string,
  ): Promise<{ orderId: string; status: string; captures: Capture[] }> {
    const res = await sdkCall('getOrder', () => this.sdk.orders.getOrder({ id: orderId }));
    const order = res.result;
    const caps = order.purchaseUnits?.[0]?.payments?.captures ?? [];
    return {
      orderId,
      status: order.status ?? '',
      captures: caps.length ? [captureFromTypedOrder(order)] : [],
    };
  }

  async getCapture(captureId: string): Promise<Capture> {
    const res = await sdkCall('getCapturedPayment', () =>
      this.sdk.payments.getCapturedPayment({ captureId }),
    );
    const cap = res.result;
    return normalizeCapture(captureWire(cap), cap.supplementaryData?.relatedIds?.orderId ?? '');
  }

  // ---------------------------------------------------------------- Payments (SDK)

  /** Refund a capture. Idempotent on requestId. */
  async refundCapture(i: {
    captureId: string;
    amountMinor: bigint;
    currency: Currency;
    requestId: string;
    note: string;
  }): Promise<Refund> {
    const res = await sdkCall('refundCapturedPayment', () =>
      this.sdk.payments.refundCapturedPayment({
        captureId: i.captureId,
        paypalRequestId: toRequestId(i.requestId),
        prefer: 'return=representation',
        body: {
          amount: {
            currencyCode: i.currency,
            value: toPayPalAmount(i.amountMinor, i.currency).value,
          },
          noteToPayer: i.note.slice(0, 255),
        },
      }),
    );
    return normalizeRefund(refundWire(res.result), i.captureId);
  }

  async getRefund(refundId: string, captureId = ''): Promise<Refund> {
    const res = await sdkCall('getRefund', () => this.sdk.payments.getRefund({ refundId }));
    return normalizeRefund(refundWire(res.result), captureId);
  }

  // ---------------------------------------------------------------- Catalog (REST)

  async createProduct(i: {
    name: string;
    description?: string;
    requestId: string;
  }): Promise<Product> {
    const { data } = await this.http.request<Json>(
      'POST',
      '/v1/catalogs/products',
      {
        name: i.name,
        type: 'DIGITAL',
        category: 'SOFTWARE',
        ...(i.description ? { description: i.description } : {}),
      },
      { requestId: i.requestId },
    );
    return { id: str(data.id) ?? '', name: str(data.name) ?? i.name };
  }

  async listProducts(): Promise<Product[]> {
    const { data } = await this.http.request<Json>('GET', '/v1/catalogs/products', undefined, {
      query: { page_size: 20 },
    });
    return asArr(data.products)
      .map(asObj)
      .map((p) => ({ id: str(p.id) ?? '', name: str(p.name) ?? '' }));
  }

  // ---------------------------------------------------------------- Subscriptions

  /**
   * Create a monthly fixed-price plan. Uses REST, not the SDK: SDK 2.5.0's PricingScheme serializes
   * `price` + a required `pricing_model` and has no `fixed_price`, which the Subscriptions API requires
   * (docs/apimatic-plugin.md, finding P5-3).
   */
  async createMonthlyPlan(i: {
    productId: string;
    name: string;
    amountMinor: bigint;
    currency: Currency;
    requestId: string;
  }): Promise<Plan> {
    const { data } = await this.http.request<Json>(
      'POST',
      '/v1/billing/plans',
      {
        product_id: i.productId,
        name: i.name,
        status: 'ACTIVE',
        billing_cycles: [
          {
            frequency: { interval_unit: 'MONTH', interval_count: 1 },
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: 0,
            pricing_scheme: { fixed_price: toPayPalAmount(i.amountMinor, i.currency) },
          },
        ],
        payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
      },
      { requestId: i.requestId },
    );
    return {
      id: str(data.id) ?? '',
      productId: str(data.product_id) ?? i.productId,
      name: str(data.name) ?? i.name,
      status: str(data.status) ?? '',
    };
  }

  async createSubscription(i: {
    planId: string;
    requestId: string;
    customId?: string;
    returnUrl?: string;
    cancelUrl?: string;
  }): Promise<Subscription> {
    const res = await sdkCall('createSubscription', () =>
      this.sdk.subscriptions.createSubscription({
        paypalRequestId: toRequestId(i.requestId),
        prefer: 'return=representation',
        body: {
          planId: i.planId,
          ...(i.customId ? { customId: i.customId } : {}),
          applicationContext: {
            shippingPreference: ExperienceContextShippingPreference.NoShipping,
            userAction: ApplicationContextUserAction.SubscribeNow,
            returnUrl: i.returnUrl ?? 'https://example.com/agpal/subscribed',
            cancelUrl: i.cancelUrl ?? 'https://example.com/agpal/cancelled',
          },
        },
      }),
    );
    const sub = subscriptionFields(res.result);
    return {
      id: sub.id ?? '',
      planId: sub.planId ?? i.planId,
      status: sub.status ?? '',
      ...(sub.approveUrl ? { approveUrl: sub.approveUrl } : {}),
    };
  }

  async getSubscription(id: string): Promise<Subscription> {
    const res = await sdkCall('getSubscription', () =>
      this.sdk.subscriptions.getSubscription({ id }),
    );
    const sub = subscriptionFields(res.result);
    return { id, planId: sub.planId ?? '', status: sub.status ?? '' };
  }

  /**
   * Cancel a subscription. The SDK operation takes no PayPal-Request-Id, so it must not go through the SDK's
   * POST retries (audit finding P6-1). REST without a request id is never retried; a cancel whose response was
   * lost is detected by checking the status instead.
   */
  async cancelSubscription(id: string, reason: string): Promise<void> {
    try {
      await this.http.request(
        'POST',
        `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`,
        { reason: reason.slice(0, 127) },
      );
    } catch (e) {
      if (
        e instanceof PayPalError &&
        e.status === 422 &&
        (await this.getSubscription(id)).status === 'CANCELLED'
      )
        return;
      throw e;
    }
  }

  // ---------------------------------------------------------------- Invoicing (REST)

  async createInvoice(i: {
    requestId: string;
    payerEmail: string;
    currency: Currency;
    items: { name: string; quantity: number; unitAmountMinor: bigint }[];
    note?: string;
    dueInDays?: number;
    reference?: string;
  }): Promise<Invoice> {
    const { data } = await this.http.request<Json>(
      'POST',
      '/v2/invoicing/invoices',
      {
        detail: {
          currency_code: i.currency,
          ...(i.note ? { note: i.note } : {}),
          ...(i.reference ? { reference: i.reference } : {}),
          payment_term: { term_type: i.dueInDays ? `NET_${i.dueInDays}` : 'DUE_ON_RECEIPT' },
        },
        primary_recipients: [{ billing_info: { email_address: i.payerEmail } }],
        items: i.items.map((it) => ({
          name: it.name,
          quantity: String(it.quantity),
          unit_amount: toPayPalAmount(it.unitAmountMinor, i.currency),
        })),
      },
      { requestId: i.requestId },
    );
    // POST returns either the full invoice (Prefer: representation) or a link.
    const id =
      str(data.id) ??
      str(
        asArr(data.links)
          .map(asObj)
          .find((l) => l.rel === 'self')?.href,
      )
        ?.split('/')
        .pop() ??
      '';
    return id && !data.status ? this.getInvoice(id) : normalizeInvoice(data);
  }

  async getInvoice(id: string): Promise<Invoice> {
    const { data } = await this.http.request<Json>(
      'GET',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}`,
    );
    return normalizeInvoice(data);
  }

  async sendInvoice(id: string, requestId: string): Promise<void> {
    await this.http.request(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
      { send_to_invoicer: false },
      { requestId },
    );
  }

  async remindInvoice(id: string, requestId: string, note: string): Promise<void> {
    await this.http.request(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`,
      { note: note.slice(0, 500) },
      { requestId },
    );
  }

  async cancelInvoice(id: string, requestId: string, note: string): Promise<void> {
    await this.http.request(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`,
      { note: note.slice(0, 500), send_to_recipient: true },
      { requestId },
    );
  }

  // ---------------------------------------------------------------- Payouts (REST)

  /** One payout per intent: senderBatchId doubles as PayPal-Request-Id and sender_batch_id. */
  async createPayout(i: {
    senderBatchId: string;
    receiverEmail: string;
    amountMinor: bigint;
    currency: Currency;
    note: string;
    subject?: string;
  }): Promise<PayoutBatch> {
    const { data } = await this.http.request<Json>(
      'POST',
      '/v1/payments/payouts',
      {
        sender_batch_header: {
          sender_batch_id: i.senderBatchId,
          email_subject: i.subject ?? 'You have a payment from AgPal',
        },
        items: [
          {
            recipient_type: 'EMAIL',
            // Payouts v1 uses {currency, value}, unlike Orders/Payments' {currency_code, value}.
            amount: {
              currency: i.currency,
              value: toPayPalAmount(i.amountMinor, i.currency).value,
            },
            receiver: i.receiverEmail,
            note: i.note.slice(0, 4000),
            sender_item_id: i.senderBatchId,
          },
        ],
      },
      { requestId: i.senderBatchId },
    );
    const header = asObj(data.batch_header);
    return {
      batchId: str(header.payout_batch_id) ?? '',
      senderBatchId: i.senderBatchId,
      batchStatus: str(header.batch_status) ?? '',
      items: [],
    };
  }

  async getPayoutBatch(batchId: string): Promise<PayoutBatch> {
    const { data } = await this.http.request<Json>(
      'GET',
      `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
    );
    const header = asObj(data.batch_header);
    return {
      batchId,
      senderBatchId: str(asObj(header.sender_batch_header).sender_batch_id) ?? '',
      batchStatus: str(header.batch_status) ?? '',
      items: asArr(data.items).map((x) => normalizePayoutItem(asObj(x))),
    };
  }

  async getPayoutItem(itemId: string): Promise<PayoutItem> {
    const { data } = await this.http.request<Json>(
      'GET',
      `/v1/payments/payouts-item/${encodeURIComponent(itemId)}`,
    );
    return normalizePayoutItem(data);
  }

  // ---------------------------------------------------------------- Disputes (REST)

  async listDisputes(opts: { startTime?: string; status?: string } = {}): Promise<Dispute[]> {
    const { data } = await this.http.request<Json>('GET', '/v1/customer/disputes', undefined, {
      query: { start_time: opts.startTime, dispute_state: opts.status, page_size: 50 },
    });
    return asArr(data.items).map((d) => normalizeDispute(asObj(d)));
  }

  async getDispute(id: string): Promise<Dispute> {
    const { data } = await this.http.request<Json>(
      'GET',
      `/v1/customer/disputes/${encodeURIComponent(id)}`,
    );
    return normalizeDispute(data);
  }

  /** Provide text evidence (multipart is required by PayPal even without files). */
  async provideDisputeEvidence(
    id: string,
    i: { notes: string; evidenceType?: string },
  ): Promise<void> {
    const form = new FormData();
    form.append(
      'input',
      new Blob(
        [
          JSON.stringify({
            evidences: [
              { evidence_type: i.evidenceType ?? 'OTHER', notes: i.notes.slice(0, 2000) },
            ],
          }),
        ],
        {
          type: 'application/json',
        },
      ),
    );
    const token = await this.http.accessToken();
    const res = await (this.opts.fetch ?? fetch)(
      new URL(
        `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`,
        baseUrlFor(this.opts.environment),
      ),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      },
    );
    if (!res.ok)
      throw fromErrorBody(res.status, await res.json().catch(() => ({})), 'provide-evidence');
  }

  async acceptDisputeClaim(id: string, note: string, requestId: string): Promise<void> {
    await this.http.request(
      'POST',
      `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`,
      { note: note.slice(0, 2000) },
      { requestId },
    );
  }

  // ---------------------------------------------------------------- Transaction Search (SDK)

  /**
   * All transactions in [start, end], every page. Read from the raw body so no field is lost. `lastRefreshed` is
   * how far PayPal's Transaction Search data is complete (it lags real time by up to a few hours).
   */
  async searchTransactions(
    start: Date,
    end: Date,
  ): Promise<TransactionRecord[] & { lastRefreshed?: Date }> {
    const out: TransactionRecord[] & { lastRefreshed?: Date } = [];
    for (let page = 1; ; page++) {
      let res;
      try {
        res = await sdkCall('searchTransactions', () =>
          this.sdk.transactions.searchTransactions({
            startDate: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            endDate: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
            fields: 'transaction_info',
            pageSize: 500,
            page,
          }),
        );
      } catch (e) {
        // Asking for a window that starts after PayPal's last refresh returns 404 "Data for the given start date is
        // not available" rather than an empty list: no data yet, and nothing in the window is covered.
        if (
          e instanceof PayPalError &&
          e.status === 404 &&
          /start date is not available/i.test(e.message)
        ) {
          out.lastRefreshed = start;
          return out;
        }
        throw e;
      }
      const { transactions, totalPages, lastRefreshed } = searchPage(res.result);
      for (const t of transactions) out.push(normalizeTransaction(transactionWire(t)));
      if (lastRefreshed && !Number.isNaN(lastRefreshed.getTime()))
        out.lastRefreshed = lastRefreshed;
      if (page >= totalPages) break;
    }
    return out;
  }

  async balances(currency: Currency): Promise<Balance> {
    const res = await sdkCall('searchBalances', () =>
      this.sdk.transactions.searchBalances({ currencyCode: currency }),
    );
    const b = balanceWire(res.result, currency);
    return {
      currency,
      availableMinor: fromPayPalAmount(b.available)?.amountMinor ?? 0n,
      withheldMinor: fromPayPalAmount(b.withheld)?.amountMinor ?? 0n,
      totalMinor: fromPayPalAmount(b.total)?.amountMinor ?? 0n,
      ...(b.asOf ? { asOf: b.asOf } : {}),
    };
  }

  // ---------------------------------------------------------------- Webhooks (REST)

  /**
   * Verify a webhook with PayPal's verify-webhook-signature API. `rawBody` must be the exact bytes received
   * (re-serialized JSON breaks the signature).
   */
  async verifyWebhook(i: {
    webhookId: string;
    headers: Record<string, string | undefined>;
    rawBody: string;
  }): Promise<boolean> {
    const h = (k: string) => i.headers[k] ?? i.headers[k.toLowerCase()];
    const required = [
      'paypal-auth-algo',
      'paypal-cert-url',
      'paypal-transmission-id',
      'paypal-transmission-sig',
      'paypal-transmission-time',
    ];
    if (required.some((k) => !h(k))) return false;
    let event: unknown;
    try {
      event = JSON.parse(i.rawBody);
    } catch {
      return false;
    }
    const { data } = await this.http.request<Json>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: i.webhookId,
        webhook_event: event,
      },
    );
    return data.verification_status === 'SUCCESS';
  }

  /** Register (or find) a webhook for our URL. */
  async ensureWebhook(url: string, events: readonly string[]): Promise<string> {
    const { data } = await this.http.request<Json>('GET', '/v1/notifications/webhooks');
    const existing = asArr(data.webhooks)
      .map(asObj)
      .find((w) => w.url === url);
    if (existing) return str(existing.id) ?? '';
    const created = await this.http.request<Json>('POST', '/v1/notifications/webhooks', {
      url,
      event_types: events.map((name) => ({ name })),
    });
    return str(created.data.id) ?? '';
  }

  /**
   * Events PayPal sent to this app's webhooks, newest first (`/v1/notifications/webhooks-events`). Fetched over our
   * authenticated API connection, so they need no signature check. Used to catch up when deliveries cannot reach us.
   */
  async listWebhookEvents(
    since: Date,
    pageSize = 50,
  ): Promise<
    {
      id: string;
      event_type: string;
      resource_type?: string;
      resource?: Record<string, unknown>;
      create_time?: string;
    }[]
  > {
    const { data } = await this.http.request<Json>(
      'GET',
      '/v1/notifications/webhooks-events',
      undefined,
      {
        query: { page_size: pageSize, start_time: since.toISOString() },
      },
    );
    return asArr(data.events)
      .map(asObj)
      .map((e) => ({
        id: str(e.id) ?? '',
        event_type: str(e.event_type) ?? '',
        ...(str(e.resource_type) ? { resource_type: str(e.resource_type) ?? '' } : {}),
        resource: asObj(e.resource),
        ...(str(e.create_time) ? { create_time: str(e.create_time) ?? '' } : {}),
      }));
  }

  /** Ask PayPal to send a sample event to a webhook (sandbox simulator). */
  async simulateWebhookEvent(
    webhookId: string,
    eventType: string,
    resourceVersion?: string,
  ): Promise<void> {
    await this.http.request('POST', '/v1/notifications/simulate-event', {
      webhook_id: webhookId,
      event_type: eventType,
      ...(resourceVersion ? { resource_version: resourceVersion } : {}),
    });
  }
}

// ------------------------------------------------------------------ normalizers (pure, exported for tests)

export function captureFromOrder(order: Json): Capture {
  const pu = asObj(asArr(order.purchase_units)[0]);
  const cap = asObj(asArr(asObj(pu.payments).captures)[0]);
  if (!cap.id)
    throw new PayPalError(
      `Order ${str(order.id) ?? '?'} has no capture (status ${str(order.status) ?? '?'})`,
      undefined,
      'NO_CAPTURE',
      undefined,
      false,
    );
  return normalizeCapture(cap, str(order.id) ?? '');
}

/** SDK path: the typed Order model's first capture, validated by the same normalizer. */
export function captureFromTypedOrder(order: Order): Capture {
  const { capture, orderId } = orderCaptureWire(order);
  return normalizeCapture(capture, orderId);
}

export function normalizeCapture(cap: Json, orderId: string): Capture {
  const breakdown = asObj(cap.seller_receivable_breakdown);
  const gross = requireAmount(
    (breakdown.gross_amount ?? cap.amount) as AmountLike,
    'capture gross',
  );
  const fee = fromPayPalAmount(breakdown.paypal_fee as AmountLike)?.amountMinor;
  const net = fromPayPalAmount(breakdown.net_amount as AmountLike)?.amountMinor;
  const status = str(cap.status) ?? '';
  if (status === 'COMPLETED' && (fee === undefined || net === undefined)) {
    throw new PayPalError(
      `Capture ${str(cap.id) ?? '?'} is COMPLETED but has no fee/net breakdown`,
      undefined,
      'MISSING_BREAKDOWN',
      undefined,
      false,
    );
  }
  const feeMinor = fee ?? 0n;
  const netMinor = net ?? gross.amountMinor - feeMinor;
  if (gross.amountMinor !== feeMinor + netMinor) {
    throw new PayPalError(
      `Capture ${str(cap.id) ?? '?'}: gross ≠ fee + net`,
      undefined,
      'BREAKDOWN_MISMATCH',
      undefined,
      false,
    );
  }
  return {
    orderId,
    captureId: str(cap.id) ?? '',
    status,
    currency: gross.currency,
    grossMinor: gross.amountMinor,
    feeMinor,
    netMinor,
    ...(str(cap.custom_id) ? { customId: str(cap.custom_id) ?? '' } : {}),
    ...(str(cap.invoice_id) ? { invoiceId: str(cap.invoice_id) ?? '' } : {}),
    ...(str(cap.create_time) ? { createTime: str(cap.create_time) ?? '' } : {}),
  };
}

export function normalizeRefund(r: Json, captureId: string): Refund {
  const breakdown = asObj(r.seller_payable_breakdown);
  const gross = requireAmount((breakdown.gross_amount ?? r.amount) as AmountLike, 'refund gross');
  const feeReturned = fromPayPalAmount(breakdown.paypal_fee as AmountLike)?.amountMinor ?? 0n;
  const net =
    fromPayPalAmount(breakdown.net_amount as AmountLike)?.amountMinor ??
    gross.amountMinor - feeReturned;
  const linkedCapture = asArr(r.links)
    .map(asObj)
    .find((l) => l.rel === 'up')?.href;
  return {
    refundId: str(r.id) ?? '',
    captureId: captureId || (str(linkedCapture)?.split('/').pop() ?? ''),
    status: str(r.status) ?? '',
    currency: gross.currency,
    grossMinor: gross.amountMinor,
    feeReturnedMinor: feeReturned,
    netMinor: net,
  };
}

export function normalizePayoutItem(i: Json): PayoutItem {
  const item = asObj(i.payout_item);
  const amount = requireAmount(item.amount as AmountLike, 'payout amount');
  const fee = fromPayPalAmount(i.payout_item_fee as AmountLike)?.amountMinor;
  return {
    itemId: str(i.payout_item_id) ?? '',
    ...(str(i.transaction_id) ? { transactionId: str(i.transaction_id) ?? '' } : {}),
    status: str(i.transaction_status) ?? 'PENDING',
    currency: amount.currency,
    amountMinor: amount.amountMinor,
    ...(fee !== undefined ? { feeMinor: fee } : {}),
    receiver: str(item.receiver) ?? '',
    ...(str(item.sender_item_id) ? { senderItemId: str(item.sender_item_id) ?? '' } : {}),
    ...(str(asObj(i.errors).name) ? { errorName: str(asObj(i.errors).name) ?? '' } : {}),
  };
}

export function normalizeInvoice(d: Json): Invoice {
  const detail = asObj(d.detail);
  const total = fromPayPalAmount(asObj(d.amount));
  const payer = str(asObj(asObj(asArr(d.primary_recipients)[0]).billing_info).email_address);
  const due = str(asObj(detail.payment_term).due_date);
  return {
    id: str(d.id) ?? '',
    status: str(d.status) ?? '',
    ...(str(detail.invoice_number) ? { number: str(detail.invoice_number) ?? '' } : {}),
    ...(total ? { totalMinor: total.amountMinor, currency: total.currency } : {}),
    ...(payer ? { payerEmail: payer } : {}),
    ...(due ? { dueDate: due } : {}),
  };
}

export function normalizeDispute(d: Json): Dispute {
  const amount = fromPayPalAmount(d.dispute_amount as AmountLike);
  const tx = asObj(asArr(d.disputed_transactions)[0]);
  return {
    id: str(d.dispute_id) ?? '',
    status: str(d.status) ?? '',
    ...(str(d.reason) ? { reason: str(d.reason) ?? '' } : {}),
    ...(str(d.dispute_life_cycle_stage) ? { stage: str(d.dispute_life_cycle_stage) ?? '' } : {}),
    ...(amount ? { amountMinor: amount.amountMinor, currency: amount.currency } : {}),
    ...(str(tx.seller_transaction_id) ? { captureId: str(tx.seller_transaction_id) ?? '' } : {}),
    ...(str(d.seller_response_due_date)
      ? { sellerResponseDueDate: str(d.seller_response_due_date) ?? '' }
      : {}),
    ...(str(asObj(d.dispute_outcome).outcome_code)
      ? { outcome: str(asObj(d.dispute_outcome).outcome_code) ?? '' }
      : {}),
  };
}

export function normalizeTransaction(t: Json): TransactionRecord {
  const gross = requireAmount(t.transaction_amount as AmountLike, 'transaction amount');
  const fee = fromPayPalAmount(t.fee_amount as AmountLike)?.amountMinor ?? 0n;
  return {
    transactionId: str(t.transaction_id) ?? '',
    eventCode: str(t.transaction_event_code) ?? '',
    status: str(t.transaction_status) ?? '',
    currency: currencyOf(gross.currency),
    grossMinor: gross.amountMinor,
    feeMinor: fee,
    netMinor: gross.amountMinor + fee,
    initiatedAt: str(t.transaction_initiation_date) ?? '',
    ...(str(t.paypal_reference_id) ? { referenceId: str(t.paypal_reference_id) ?? '' } : {}),
    ...(str(t.invoice_id) ? { invoiceId: str(t.invoice_id) ?? '' } : {}),
    ...(str(t.custom_field) ? { customField: str(t.custom_field) ?? '' } : {}),
  };
}
