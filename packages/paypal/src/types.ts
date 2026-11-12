import type { Currency } from '@agpal/shared';

/** Normalized types. SDK and raw REST types never leave packages/paypal. */

export interface CreatedOrder {
  orderId: string;
  status: string;
  /** Buyer approval link (PayPal wallet checkout). */
  approveUrl?: string;
}

export interface Capture {
  orderId: string;
  captureId: string;
  status: string;
  currency: Currency;
  grossMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  customId?: string;
  invoiceId?: string;
  createTime?: string;
}

export interface Refund {
  refundId: string;
  captureId: string;
  status: string;
  currency: Currency;
  grossMinor: bigint;
  /** Fee PayPal returned to us on the refund (often 0). */
  feeReturnedMinor: bigint;
  netMinor: bigint;
}

export interface PayoutBatch {
  batchId: string;
  senderBatchId: string;
  batchStatus: string;
  items: PayoutItem[];
}

export interface PayoutItem {
  itemId: string;
  transactionId?: string;
  /** SUCCESS, PENDING, UNCLAIMED, FAILED, RETURNED, ONHOLD, BLOCKED, REFUNDED, REVERSED, DENIED */
  status: string;
  currency: Currency;
  amountMinor: bigint;
  /** Known once processed. */
  feeMinor?: bigint;
  receiver: string;
  senderItemId?: string;
  errorName?: string;
}

export interface Product {
  id: string;
  name: string;
}

export interface Plan {
  id: string;
  productId: string;
  name: string;
  status: string;
}

export interface Subscription {
  id: string;
  planId: string;
  status: string;
  approveUrl?: string;
}

export interface Invoice {
  id: string;
  status: string;
  number?: string;
  totalMinor?: bigint;
  currency?: Currency;
  payerEmail?: string;
  dueDate?: string;
}

export interface Dispute {
  id: string;
  status: string;
  reason?: string;
  stage?: string;
  amountMinor?: bigint;
  currency?: Currency;
  captureId?: string;
  sellerResponseDueDate?: string;
  outcome?: string;
}

export interface TransactionRecord {
  transactionId: string;
  /** PayPal transaction event code, e.g. T0006 (checkout), T1107 (refund), T0400s (withdrawal/payout). */
  eventCode: string;
  status: string;
  currency: Currency;
  grossMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  initiatedAt: string;
  /** For refunds/reversals: the original transaction. */
  referenceId?: string;
  invoiceId?: string;
  customField?: string;
}

export interface Balance {
  currency: Currency;
  availableMinor: bigint;
  withheldMinor: bigint;
  totalMinor: bigint;
  asOf?: string;
}
