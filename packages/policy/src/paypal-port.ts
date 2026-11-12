import { setTimeout as sleep } from 'node:timers/promises';
import type { PayPal } from '@agpal/paypal';
import type {
  PaymentsPort,
  PayoutRequest,
  PayoutResult,
  RefundRequest,
  RefundResult,
} from './ports.js';

/**
 * The gate's PaymentsPort backed by real PayPal (Prompt 5). Lives in packages/policy because only the
 * gate may reach @agpal/paypal (invariant 1).
 */
export class PayPalPayments implements PaymentsPort {
  constructor(
    private readonly paypal: PayPal,
    private readonly opts: { payoutSettleWaitMs?: number; pollEveryMs?: number } = {},
  ) {}

  async payout(req: PayoutRequest): Promise<PayoutResult> {
    const batch = await this.paypal.createPayout({
      senderBatchId: req.senderBatchId,
      receiverEmail: req.receiverEmail,
      amountMinor: req.amountMinor,
      currency: req.currency,
      note: req.note,
    });
    // PayPal reports the item fee only once the batch is processed (~20–40s in sandbox). Wait a bounded time;
    // otherwise the intent stays `pending` and the worker / webhook settles it.
    const deadline = Date.now() + (this.opts.payoutSettleWaitMs ?? 0);
    for (;;) {
      const status = await this.paypal.getPayoutBatch(batch.batchId);
      const item = status.items[0];
      if (item?.feeMinor !== undefined) {
        return {
          batchId: batch.batchId,
          itemId: item.itemId,
          itemStatus: item.status,
          feeMinor: item.feeMinor,
        };
      }
      if (Date.now() >= deadline) {
        return {
          batchId: batch.batchId,
          ...(item ? { itemId: item.itemId } : {}),
          itemStatus: item?.status ?? status.batchStatus,
        };
      }
      await sleep(this.opts.pollEveryMs ?? 3000);
    }
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const r = await this.paypal.refundCapture({
      captureId: req.captureId,
      amountMinor: req.amountMinor,
      currency: req.currency,
      requestId: req.idempotencyKey,
      note: req.note,
    });
    return {
      refundId: r.refundId,
      status: r.status,
      grossMinor: r.grossMinor,
      feeReturnedMinor: r.feeReturnedMinor,
    };
  }
}
