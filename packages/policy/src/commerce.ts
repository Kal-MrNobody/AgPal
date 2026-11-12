import type { Capture, CreatedOrder, PayPal } from '@agpal/paypal';
import { ACC, type Ledger } from '@agpal/ledger';
import { newId, type Attribution, type Currency } from '@agpal/shared';

export type RevenueKind = 'sales' | 'subscriptions';

/**
 * Inbound money (constitution §2.2). Receiving money is not a spend, so it skips the rules, but it still
 * goes through packages/policy: nothing else may call PayPal (invariant 1). Every capture is booked once,
 * keyed by its PayPal capture id, whether it arrives from the API or a webhook.
 */
export class Commerce {
  constructor(
    private readonly ledger: Ledger,
    private readonly paypal: Pick<
      PayPal,
      'createOrder' | 'captureOrder' | 'createAndCaptureSandboxCardOrder'
    >,
  ) {}

  /** A checkout link for a customer (PAY_NOW, NO_SHIPPING). */
  createCheckout(i: {
    companyId: string;
    amountMinor: bigint;
    currency: Currency;
    description: string;
    reference: string;
  }): Promise<CreatedOrder> {
    return this.paypal.createOrder({
      amountMinor: i.amountMinor,
      currency: i.currency,
      description: i.description,
      customId: `agpal:${i.companyId}:${i.reference}`,
      requestId: `order:${i.companyId}:${i.reference}`,
    });
  }

  /** Capture an approved order and book it. */
  async capture(
    companyId: string,
    orderId: string,
    kind: RevenueKind = 'sales',
    attribution?: Attribution,
  ): Promise<Capture> {
    const capture = await this.paypal.captureOrder(orderId, `capture:${orderId}`);
    await this.bookCapture(companyId, capture, kind, attribution);
    return capture;
  }

  /** Sandbox: a card-paid order, captured and booked, with no browser. */
  async sandboxCardSale(i: {
    companyId: string;
    amountMinor: bigint;
    currency: Currency;
    description: string;
    reference?: string;
  }): Promise<Capture> {
    const reference = i.reference ?? newId('sale');
    const capture = await this.paypal.createAndCaptureSandboxCardOrder({
      amountMinor: i.amountMinor,
      currency: i.currency,
      description: i.description,
      customId: `agpal:${i.companyId}:${reference}`,
      requestId: `cardsale:${i.companyId}:${reference}`,
    });
    await this.bookCapture(i.companyId, capture, 'sales');
    return capture;
  }

  /** Book a completed capture: Dr cash net, Dr fees, Cr revenue gross. Idempotent on the capture id. */
  async bookCapture(
    companyId: string,
    c: Capture,
    kind: RevenueKind = 'sales',
    attribution?: Attribution,
    dept = 'revenue',
  ): Promise<void> {
    if (c.status !== 'COMPLETED') return; // PENDING captures are booked when PAYMENT.CAPTURE.COMPLETED arrives.
    const revenue = kind === 'sales' ? ACC.sales(dept) : ACC.subscriptions(dept);
    await this.ledger.post({
      companyId,
      currency: c.currency,
      actor: attribution ? 'agent' : 'system',
      ...(attribution ? { attribution } : {}),
      description: `Capture ${c.captureId} (order ${c.orderId})`,
      flow: 'capture',
      postings: [
        { account: ACC.unallocated, amountMinor: c.netMinor },
        ...(c.feeMinor > 0n ? [{ account: ACC.paypalFees, amountMinor: c.feeMinor }] : []),
        { account: revenue, amountMinor: -c.grossMinor },
      ],
      externalRef: c.captureId,
      idempotencyKey: `paypal:capture:${c.captureId}`,
      metadata: { orderId: c.orderId, customId: c.customId, kind },
    });
  }
}
