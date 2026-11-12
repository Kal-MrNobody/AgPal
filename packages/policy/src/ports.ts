import type { Currency } from '@agpal/shared';

/**
 * What the gate needs from a payment provider. packages/paypal implements it (Prompt 5); tests and dry
 * mode use FakePayments. Amounts are minor units; idempotency keys are mandatory (invariant 4).
 */
export interface PayoutRequest {
  /** One payout per intent: the intent id is PayPal's sender_batch_id. */
  senderBatchId: string;
  receiverEmail: string;
  amountMinor: bigint;
  currency: Currency;
  note: string;
}

export interface PayoutResult {
  batchId: string;
  itemId?: string;
  /** The PayPal transaction id (what Transaction Search reports). */
  transactionId?: string;
  /** PayPal transaction status of the item, e.g. SUCCESS, PENDING, UNCLAIMED. */
  itemStatus: string;
  /** Known once PayPal processed the item; undefined means "still pending". */
  feeMinor?: bigint;
}

export interface RefundRequest {
  captureId: string;
  amountMinor: bigint;
  currency: Currency;
  idempotencyKey: string;
  note: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
  grossMinor: bigint;
  /** Fee PayPal gave back (often 0). */
  feeReturnedMinor: bigint;
}

export interface PaymentsPort {
  payout(req: PayoutRequest): Promise<PayoutResult>;
  refund(req: RefundRequest): Promise<RefundResult>;
}

/** Deterministic in-memory provider. Never touches the network. */
export class FakePayments implements PaymentsPort {
  readonly payouts: PayoutRequest[] = [];
  readonly refunds: RefundRequest[] = [];
  /** 2% capped at $1.00, like the constitution's worked example. */
  payoutFee = (amount: bigint): bigint => {
    const fee = (amount * 2n + 50n) / 100n;
    return fee > 100n ? 100n : fee;
  };
  failNext: Error | undefined;

  payout(req: PayoutRequest): Promise<PayoutResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      return Promise.reject(e);
    }
    const existing = this.payouts.find((p) => p.senderBatchId === req.senderBatchId);
    if (!existing) this.payouts.push(req);
    return Promise.resolve({
      batchId: `FAKEBATCH-${req.senderBatchId}`,
      itemId: `FAKEITEM-${req.senderBatchId}`,
      itemStatus: 'SUCCESS',
      feeMinor: this.payoutFee(req.amountMinor),
    });
  }

  refund(req: RefundRequest): Promise<RefundResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      return Promise.reject(e);
    }
    if (!this.refunds.some((r) => r.idempotencyKey === req.idempotencyKey)) this.refunds.push(req);
    return Promise.resolve({
      refundId: `FAKEREFUND-${req.idempotencyKey}`,
      status: 'COMPLETED',
      grossMinor: req.amountMinor,
      feeReturnedMinor: 0n,
    });
  }
}
