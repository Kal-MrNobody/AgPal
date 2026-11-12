import type { PayPal } from '@agpal/paypal';

/**
 * Read-only PayPal access for apps/api (webhook verification) and apps/worker (reconciliation, enrichment).
 * Nothing here moves money. Apps never import @agpal/paypal or hold the raw client (invariant 1, ADR-012).
 */
export type PayPalInbound = Pick<
  PayPal,
  | 'verifyWebhook'
  | 'searchTransactions'
  | 'balances'
  | 'getCapture'
  | 'getRefund'
  | 'getPayoutItem'
  | 'getPayoutBatch'
  | 'getDispute'
  | 'listDisputes'
  | 'ensureWebhook'
  | 'simulateWebhookEvent'
  | 'listWebhookEvents'
>;

export type { TransactionRecord, Balance, Capture, Dispute } from '@agpal/paypal';
export { PayPalError } from '@agpal/paypal';
