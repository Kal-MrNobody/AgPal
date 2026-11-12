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
    > &
      Partial<
        Pick<
          PayPal,
          | 'createProduct'
          | 'createMonthlyPlan'
          | 'createSubscription'
          | 'createInvoice'
          | 'sendInvoice'
          | 'remindInvoice'
          | 'provideDisputeEvidence'
          | 'getDispute'
        >
      >,
  ) {}

  /** Create a catalog product (digital goods). */
  async createProduct(
    companyId: string,
    name: string,
    description?: string,
  ): Promise<{ id: string; name: string }> {
    if (!this.paypal.createProduct) throw new Error('catalog not available');
    return this.paypal.createProduct({
      name,
      ...(description ? { description } : {}),
      requestId: `product:${companyId}:${name}`,
    });
  }

  /** Create a monthly subscription plan for a product. */
  async createMonthlyPlan(
    companyId: string,
    productId: string,
    name: string,
    amountMinor: bigint,
    currency: Currency,
  ): Promise<{ id: string; status: string }> {
    if (!this.paypal.createMonthlyPlan) throw new Error('plans not available');
    return this.paypal.createMonthlyPlan({
      productId,
      name,
      amountMinor,
      currency,
      requestId: `plan:${companyId}:${productId}:${name}:${amountMinor}`,
    });
  }

  /** Start a subscription; the customer approves it at `approveUrl`. */
  async createSubscription(
    companyId: string,
    planId: string,
    reference: string,
  ): Promise<{ id: string; status: string; approveUrl?: string }> {
    if (!this.paypal.createSubscription) throw new Error('subscriptions not available');
    return this.paypal.createSubscription({
      planId,
      customId: `agpal:${companyId}:${reference}`,
      requestId: `sub:${companyId}:${reference}`,
    });
  }

  /** Create and send a PayPal invoice for custom work. Returns the PayPal invoice id. */
  async invoiceCustomer(i: {
    companyId: string;
    payerEmail: string;
    items: { name: string; quantity: number; unitAmountMinor: bigint }[];
    note?: string;
    dueInDays?: number;
    reference: string;
  }): Promise<{ id: string; status: string }> {
    if (!this.paypal.createInvoice || !this.paypal.sendInvoice)
      throw new Error('invoicing not available');
    const inv = await this.paypal.createInvoice({
      requestId: `invoice:${i.companyId}:${i.reference}`,
      payerEmail: i.payerEmail,
      currency: 'USD',
      items: i.items,
      ...(i.note ? { note: i.note } : {}),
      ...(i.dueInDays ? { dueInDays: i.dueInDays } : {}),
      reference: `agpal:${i.companyId}:${i.reference}`,
    });
    await this.paypal.sendInvoice(inv.id, `invoice-send:${inv.id}`);
    return { id: inv.id, status: 'SENT' };
  }

  async remindInvoice(invoiceId: string, note: string): Promise<void> {
    if (!this.paypal.remindInvoice) throw new Error('invoicing not available');
    await this.paypal.remindInvoice(
      invoiceId,
      `invoice-remind:${invoiceId}:${new Date().toISOString().slice(0, 10)}`,
      note,
    );
  }

  /** Submit dispute evidence (text). Not a money movement; accepting a claim goes through the gate. */
  async submitDisputeEvidence(disputeId: string, notes: string): Promise<void> {
    if (!this.paypal.provideDisputeEvidence) throw new Error('disputes not available');
    await this.paypal.provideDisputeEvidence(disputeId, { notes });
  }

  async getDispute(disputeId: string): Promise<unknown> {
    if (!this.paypal.getDispute) throw new Error('disputes not available');
    return this.paypal.getDispute(disputeId);
  }

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
    extraMetadata: Record<string, unknown> = {},
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
      metadata: { orderId: c.orderId, customId: c.customId, kind, ...extraMetadata },
    });
  }
}
