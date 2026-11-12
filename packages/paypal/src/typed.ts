import type {
  BalancesResponse,
  CapturedPayment,
  LinkDescription,
  Money,
  Order,
  OrdersCapture,
  Refund as SdkRefund,
  SearchResponse,
  Subscription as SdkSubscription,
  TransactionInformation,
} from '@paypal/paypal-server-sdk';
import { PayPalError } from './errors.js';

/**
 * SDK responses are read through the Server SDK's typed models (ADR-017, plugin skill typescript-models): camelCase
 * fields, `Money` = { currencyCode, value }. Each mapper hands the fields to the same validating normalizer the
 * webhook path uses (webhook payloads are raw PayPal JSON, not SDK models), so the money checks live in one place:
 * gross = fee + net, a COMPLETED capture must carry its fee breakdown, amounts parse to integer minor units.
 */

type Wire = Record<string, unknown>;

/** SDK Money → the PayPal wire amount our amount parser validates. */
export const wireMoney = (m: Money | undefined): Wire | undefined =>
  m ? { currency_code: m.currencyCode, value: m.value } : undefined;

const defined = (o: Wire): Wire =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function captureWire(c: OrdersCapture | CapturedPayment): Wire {
  const b = c.sellerReceivableBreakdown;
  return defined({
    id: c.id,
    status: c.status,
    amount: wireMoney(c.amount),
    seller_receivable_breakdown: b
      ? defined({
          gross_amount: wireMoney(b.grossAmount),
          paypal_fee: wireMoney(b.paypalFee),
          net_amount: wireMoney(b.netAmount),
        })
      : undefined,
    custom_id: c.customId,
    invoice_id: c.invoiceId,
    create_time: c.createTime,
  });
}

/** The first capture of an order, or NO_CAPTURE. */
export function orderCaptureWire(o: Order): { capture: Wire; orderId: string } {
  const cap = o.purchaseUnits?.[0]?.payments?.captures?.[0];
  if (!cap?.id)
    throw new PayPalError(
      `Order ${o.id ?? '?'} has no capture (status ${o.status ?? '?'})`,
      undefined,
      'NO_CAPTURE',
      undefined,
      false,
    );
  return { capture: captureWire(cap), orderId: o.id ?? '' };
}

export function refundWire(r: SdkRefund): Wire {
  const b = r.sellerPayableBreakdown;
  return defined({
    id: r.id,
    status: r.status,
    amount: wireMoney(r.amount),
    seller_payable_breakdown: b
      ? defined({
          gross_amount: wireMoney(b.grossAmount),
          paypal_fee: wireMoney(b.paypalFee),
          net_amount: wireMoney(b.netAmount),
        })
      : undefined,
    links: r.links?.map((l) => ({ rel: l.rel, href: l.href })),
  });
}

export const linkHref = (links: LinkDescription[] | undefined, ...rels: string[]) =>
  links?.find((l) => rels.includes(l.rel))?.href;

export function transactionWire(t: TransactionInformation): Wire {
  return defined({
    transaction_id: t.transactionId,
    transaction_event_code: t.transactionEventCode,
    transaction_status: t.transactionStatus,
    transaction_amount: wireMoney(t.transactionAmount),
    fee_amount: wireMoney(t.feeAmount),
    transaction_initiation_date: t.transactionInitiationDate,
    paypal_reference_id: t.paypalReferenceId,
    invoice_id: t.invoiceId,
    custom_field: t.customField,
  });
}

export const searchPage = (r: SearchResponse) => ({
  transactions: (r.transactionDetails ?? [])
    .map((d) => d.transactionInfo)
    .filter((t): t is TransactionInformation => t !== undefined),
  totalPages: r.totalPages ?? 1,
  /** PayPal's data is complete up to this time (Transaction Search lags real time by up to ~3 hours). */
  lastRefreshed: r.lastRefreshedDatetime ? new Date(r.lastRefreshedDatetime) : undefined,
});

export function balanceWire(r: BalancesResponse, currency: string) {
  const b = r.balances?.find((x) => x.currency === currency);
  return {
    available: wireMoney(b?.availableBalance),
    withheld: wireMoney(b?.withheldBalance),
    total: wireMoney(b?.totalBalance),
    asOf: r.asOfTime,
  };
}

export const subscriptionFields = (s: SdkSubscription) => ({
  id: s.id,
  planId: s.planId,
  status: s.status as string | undefined,
  approveUrl: linkHref(s.links, 'approve'),
});
