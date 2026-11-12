import { and, eq } from 'drizzle-orm';
import { alerts, domainEvents, spendIntents, type Database } from '@agpal/db';
import { ACC, InsufficientFundsError, type Ledger } from '@agpal/ledger';
import {
  normalizeCapture,
  normalizeDispute,
  normalizePayoutItem,
  normalizeRefund,
  type Capture,
} from '@agpal/paypal';
import { isCurrency, newId, parseDecimal } from '@agpal/shared';
import type { Commerce } from './commerce.js';
import type { Gate } from './gate.js';
import type { PayPalInbound } from './inbound.js';

/** The PayPal events AgPal subscribes to (register exactly these). */
export const PAYPAL_WEBHOOK_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'PAYMENT.SALE.COMPLETED',
  'INVOICING.INVOICE.PAID',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'PAYMENT.PAYOUTS-ITEM.DENIED',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED',
] as const;

export interface PayPalEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
  create_time?: string;
}

export type ProcessOutcome = 'booked' | 'recorded' | 'ignored' | 'suspense';

export interface ProcessResult {
  outcome: ProcessOutcome;
  companyId?: string;
  detail: string;
}

/** Thrown when an event arrived before what it depends on (e.g. a refund before its capture). Retry later. */
export class RetryLaterError extends Error {
  override name = 'RetryLaterError';
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const PAYOUT_REVERSING = new Set([
  'FAILED',
  'RETURNED',
  'BLOCKED',
  'CANCELED',
  'DENIED',
  'REFUNDED',
  'REVERSED',
]);

/**
 * Maps PayPal webhook events to the constitution's ledger flows (§2). Every booking is idempotent on PayPal ids,
 * so duplicates and replays are no-ops; out-of-order events throw RetryLaterError; anything that cannot be matched
 * goes to suspense with an alert — never dropped.
 */
export class WebhookProcessor {
  constructor(
    private readonly db: Database,
    private readonly ledger: Ledger,
    private readonly gate: Gate,
    private readonly commerce: Commerce,
    private readonly paypal: Pick<PayPalInbound, 'getCapture'>,
    private readonly opts: { defaultCompanyId?: string } = {},
  ) {}

  async process(
    event: PayPalEvent,
    ctx: { simulated?: boolean; finalAttempt?: boolean } = {},
  ): Promise<ProcessResult> {
    const r = obj(event.resource);
    const meta = { webhookEventId: event.id, simulated: ctx.simulated ?? false };
    try {
      switch (event.event_type) {
        case 'PAYMENT.CAPTURE.COMPLETED':
          return await this.captureCompleted(event, normalizeCapture(r, this.orderIdOf(r)), meta);
        case 'PAYMENT.CAPTURE.REFUNDED':
        case 'PAYMENT.CAPTURE.REVERSED':
          return await this.refunded(event, r, meta);
        case 'PAYMENT.SALE.COMPLETED':
          return await this.saleCompleted(event, r);
        case 'INVOICING.INVOICE.PAID':
          return await this.invoicePaid(event, r);
        case 'CUSTOMER.DISPUTE.CREATED':
        case 'CUSTOMER.DISPUTE.UPDATED':
        case 'CUSTOMER.DISPUTE.RESOLVED':
          return await this.dispute(event, r, meta);
        default:
          if (event.event_type.startsWith('PAYMENT.PAYOUTS-ITEM.'))
            return await this.payoutItem(event, r);
          if (event.event_type.startsWith('BILLING.SUBSCRIPTION.'))
            return await this.subscription(event, r);
          return { outcome: 'ignored', detail: `Unhandled event type ${event.event_type}` };
      }
    } catch (e) {
      // Out of order (e.g. refund before capture): retry, then suspense on the final attempt.
      if (
        (e instanceof InsufficientFundsError || e instanceof RetryLaterError) &&
        !ctx.finalAttempt
      ) {
        throw new RetryLaterError(e.message);
      }
      if (e instanceof InsufficientFundsError || e instanceof RetryLaterError) {
        return this.suspense(
          this.opts.defaultCompanyId,
          event,
          `Could not book after retries: ${e.message}`,
        );
      }
      throw e;
    }
  }

  private orderIdOf(r: Json): string {
    return str(obj(obj(r.supplementary_data).related_ids).order_id) ?? '';
  }

  /** `agpal:<companyId>:<ref>` custom ids identify the company; otherwise the configured default. */
  private companyFromCustomId(customId: string | undefined): string | undefined {
    const m = customId ? /^agpal:([^:]+):/.exec(customId) : null;
    return m?.[1] ?? this.opts.defaultCompanyId;
  }

  private async captureCompleted(
    event: PayPalEvent,
    c: Capture,
    meta: Json,
  ): Promise<ProcessResult> {
    const companyId = this.companyFromCustomId(c.customId);
    if (!companyId) return this.suspense(undefined, event, `Capture ${c.captureId} has no company`);
    await this.commerce.bookCapture(companyId, c, 'sales');
    await this.publish(companyId, 'revenue.received', 'revenue', `capture:${c.captureId}`, {
      captureId: c.captureId,
      grossMinor: c.grossMinor.toString(),
      netMinor: c.netMinor.toString(),
      currency: c.currency,
      ...meta,
    });
    return { outcome: 'booked', companyId, detail: `capture ${c.captureId}` };
  }

  private async refunded(event: PayPalEvent, r: Json, meta: Json): Promise<ProcessResult> {
    const refund = normalizeRefund(r, '');
    const captureEntry = refund.captureId
      ? await this.ledger.findByExternalRef(refund.captureId)
      : undefined;
    if (!captureEntry)
      throw new RetryLaterError(
        `Capture ${refund.captureId || '?'} for refund ${refund.refundId} not booked yet`,
      );
    await this.gate.bookRefund(captureEntry.companyId, refund.currency, refund.captureId, {
      refundId: refund.refundId,
      grossMinor: refund.grossMinor < 0n ? -refund.grossMinor : refund.grossMinor,
      feeReturnedMinor:
        refund.feeReturnedMinor < 0n ? -refund.feeReturnedMinor : refund.feeReturnedMinor,
    });
    await this.publish(
      captureEntry.companyId,
      'refund.completed',
      'support',
      `refund:${refund.refundId}`,
      {
        refundId: refund.refundId,
        captureId: refund.captureId,
        reversal: event.event_type.endsWith('REVERSED'),
        ...meta,
      },
    );
    return {
      outcome: 'booked',
      companyId: captureEntry.companyId,
      detail: `refund ${refund.refundId}`,
    };
  }

  /** Subscription payment (v1 sale resource): amount.total, transaction_fee.value. */
  private async saleCompleted(event: PayPalEvent, r: Json): Promise<ProcessResult> {
    const amount = obj(r.amount);
    const currency = str(amount.currency);
    if (!currency || !isCurrency(currency))
      return this.suspense(this.opts.defaultCompanyId, event, 'Sale without a supported currency');
    const gross = parseDecimal(str(amount.total) ?? '0', currency).amountMinor;
    const fee = parseDecimal(str(obj(r.transaction_fee).value) ?? '0', currency).amountMinor;
    const companyId = this.companyFromCustomId(str(r.custom) ?? str(r.custom_id));
    if (!companyId)
      return this.suspense(undefined, event, `Sale ${str(r.id) ?? '?'} has no company`);
    const capture: Capture = {
      orderId: str(r.billing_agreement_id) ?? '',
      captureId: str(r.id) ?? '',
      status: str(r.state) === 'completed' ? 'COMPLETED' : (str(r.state) ?? '').toUpperCase(),
      currency,
      grossMinor: gross,
      feeMinor: fee,
      netMinor: gross - fee,
    };
    await this.commerce.bookCapture(companyId, capture, 'subscriptions');
    await this.publish(companyId, 'revenue.received', 'revenue', `capture:${capture.captureId}`, {
      captureId: capture.captureId,
      subscriptionId: capture.orderId,
      grossMinor: gross.toString(),
      currency,
    });
    return { outcome: 'booked', companyId, detail: `subscription payment ${capture.captureId}` };
  }

  /** Invoice payments: the event has no fee, so fetch the capture for gross/fee/net. */
  private async invoicePaid(event: PayPalEvent, r: Json): Promise<ProcessResult> {
    const invoice = obj(r.invoice ?? r);
    const tx = obj((obj(invoice.payments).transactions as unknown[] | undefined)?.[0]);
    const captureId = str(tx.payment_id);
    const companyId =
      this.companyFromCustomId(str(obj(invoice.detail).reference)) ?? this.opts.defaultCompanyId;
    if (!captureId || !companyId)
      return this.suspense(companyId, event, 'Paid invoice without a payment id or company');
    let capture: Capture;
    try {
      capture = await this.paypal.getCapture(captureId);
    } catch {
      return this.suspense(
        companyId,
        event,
        `Paid invoice ${str(invoice.id) ?? '?'}: could not fetch capture ${captureId}`,
      );
    }
    await this.commerce.bookCapture(companyId, capture, 'sales');
    await this.publish(
      companyId,
      'invoice.paid',
      'revenue',
      `invoice:${str(invoice.id) ?? captureId}`,
      {
        invoiceId: str(invoice.id),
        captureId,
      },
    );
    return { outcome: 'booked', companyId, detail: `invoice payment ${captureId}` };
  }

  private async dispute(event: PayPalEvent, r: Json, meta: Json): Promise<ProcessResult> {
    const d = normalizeDispute(r);
    const captureEntry = d.captureId ? await this.ledger.findByExternalRef(d.captureId) : undefined;
    const companyId = captureEntry?.companyId ?? this.opts.defaultCompanyId;
    if (!companyId || d.amountMinor === undefined || !d.currency) {
      return this.suspense(companyId, event, `Dispute ${d.id} could not be matched to a capture`);
    }
    const base = {
      companyId,
      currency: d.currency,
      actor: 'system',
      externalRef: d.id,
      metadata: { disputeId: d.id, captureId: d.captureId, ...meta },
    };
    const holdKey = `paypal:dispute:${d.id}:hold`;
    const held = await this.ledger.findEntry(companyId, holdKey);
    // Funds are withheld once per dispute, whichever event we see first.
    if (!held && event.event_type !== 'CUSTOMER.DISPUTE.RESOLVED') {
      await this.ledger.post({
        ...base,
        description: `Dispute ${d.id} opened: funds withheld`,
        flow: 'dispute_opened',
        postings: [
          { account: ACC.withheld, amountMinor: d.amountMinor },
          { account: ACC.unallocated, amountMinor: -d.amountMinor },
        ],
        idempotencyKey: holdKey,
      });
      await this.publish(companyId, 'dispute.opened', 'support', `dispute:${d.id}:opened`, {
        disputeId: d.id,
        captureId: d.captureId,
        amountMinor: d.amountMinor.toString(),
        reason: d.reason,
        dueDate: d.sellerResponseDueDate,
        ...meta,
      });
    }
    if (event.event_type === 'CUSTOMER.DISPUTE.RESOLVED') {
      if (!held && !(await this.ledger.findEntry(companyId, holdKey))) {
        // Resolved without us ever seeing it open: nothing is withheld; record only.
        await this.publish(companyId, 'dispute.resolved', 'support', `dispute:${d.id}:resolved`, {
          disputeId: d.id,
          outcome: d.outcome,
        });
        return {
          outcome: 'recorded',
          companyId,
          detail: `dispute ${d.id} resolved (never withheld)`,
        };
      }
      const won =
        d.outcome === 'RESOLVED_SELLER_FAVOUR' ||
        d.outcome === 'CANCELED_BY_BUYER' ||
        d.outcome === 'DENIED';
      await this.ledger.post({
        ...base,
        description: `Dispute ${d.id} ${won ? 'won' : 'lost'} (${d.outcome ?? 'no outcome'})`,
        flow: won ? 'dispute_won' : 'dispute_lost',
        postings: won
          ? [
              { account: ACC.unallocated, amountMinor: d.amountMinor },
              { account: ACC.withheld, amountMinor: -d.amountMinor },
            ]
          : [
              { account: ACC.refunds('revenue'), amountMinor: d.amountMinor },
              { account: ACC.withheld, amountMinor: -d.amountMinor },
            ],
        idempotencyKey: `paypal:dispute:${d.id}:resolved`,
      });
      await this.publish(companyId, 'dispute.resolved', 'support', `dispute:${d.id}:resolved`, {
        disputeId: d.id,
        outcome: d.outcome,
        won,
      });
      return { outcome: 'booked', companyId, detail: `dispute ${d.id} ${won ? 'won' : 'lost'}` };
    }
    if (event.event_type === 'CUSTOMER.DISPUTE.UPDATED') {
      await this.publish(companyId, 'dispute.updated', 'support', `dispute:${d.id}:${event.id}`, {
        disputeId: d.id,
        status: d.status,
        dueDate: d.sellerResponseDueDate,
      });
    }
    return {
      outcome: held ? 'recorded' : 'booked',
      companyId,
      detail: `dispute ${d.id} ${d.status}`,
    };
  }

  private async payoutItem(event: PayPalEvent, r: Json): Promise<ProcessResult> {
    const item = normalizePayoutItem(r);
    const intentId =
      item.senderItemId ??
      str(r.sender_batch_id) ??
      str(obj(r.sender_batch_header).sender_batch_id);
    const [intent] = intentId
      ? await this.db.select().from(spendIntents).where(eq(spendIntents.id, intentId))
      : [];
    if (!intent)
      return this.suspense(
        this.opts.defaultCompanyId,
        event,
        `Payout item ${item.itemId} matches no intent`,
      );
    const companyId = intent.companyId;
    const status = event.event_type.replace('PAYMENT.PAYOUTS-ITEM.', '');

    if (status === 'SUCCEEDED' || status === 'UNCLAIMED') {
      if (item.feeMinor === undefined)
        throw new RetryLaterError(`Payout item ${item.itemId} has no fee yet`);
      if (intent.status === 'pending' || intent.status === 'failed') {
        await this.gate.settlePayout(intent.id, { itemId: item.itemId, feeMinor: item.feeMinor });
      }
      if (status === 'UNCLAIMED') {
        await this.publish(
          companyId,
          'payout.unclaimed',
          intent.envelope,
          `payout:${item.itemId}:unclaimed`,
          { intentId: intent.id, itemId: item.itemId },
        );
      }
      return { outcome: 'booked', companyId, detail: `payout ${item.itemId} ${status}` };
    }
    if (PAYOUT_REVERSING.has(status)) {
      await this.gate.payoutReversed(intent.id, {
        itemId: item.itemId,
        status,
        reason: item.errorName ?? status,
      });
      await this.publish(
        companyId,
        'payout.failed',
        intent.envelope,
        `payout:${item.itemId}:${status}`,
        {
          intentId: intent.id,
          itemId: item.itemId,
          status,
          error: item.errorName,
        },
      );
      return { outcome: 'booked', companyId, detail: `payout ${item.itemId} ${status}: reversed` };
    }
    return { outcome: 'recorded', companyId, detail: `payout ${item.itemId} ${status}` };
  }

  private async subscription(event: PayPalEvent, r: Json): Promise<ProcessResult> {
    const companyId = this.companyFromCustomId(str(r.custom_id));
    if (!companyId) return { outcome: 'ignored', detail: 'Subscription event without company' };
    const name =
      event.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED'
        ? 'subscription.payment_failed'
        : `subscription.${event.event_type.split('.').pop()?.toLowerCase() ?? 'updated'}`;
    await this.publish(companyId, name, 'revenue', `sub:${str(r.id) ?? '?'}:${event.id}`, {
      subscriptionId: str(r.id),
      status: str(r.status),
      planId: str(r.plan_id),
    });
    return { outcome: 'recorded', companyId, detail: `${name} ${str(r.id) ?? ''}` };
  }

  private async suspense(
    companyId: string | undefined,
    event: PayPalEvent,
    message: string,
  ): Promise<ProcessResult> {
    const co = companyId ?? 'unknown';
    await this.db.insert(alerts).values({
      id: newId('alr'),
      companyId: co,
      kind: 'webhook.suspense',
      severity: 'critical',
      message,
      data: { eventId: event.id, eventType: event.event_type },
    });
    return { outcome: 'suspense', ...(companyId ? { companyId } : {}), detail: message };
  }

  /** Insert a domain event once (dedupe key). Returns true when newly published. */
  async publish(
    companyId: string,
    name: string,
    department: string | null,
    dedupeKey: string,
    payload: Json,
  ): Promise<boolean> {
    const rows = await this.db
      .insert(domainEvents)
      .values({
        id: newId('evt'),
        companyId,
        name,
        department,
        dedupeKey,
        payload,
        simulated: payload.simulated === true,
      })
      .onConflictDoNothing()
      .returning({ id: domainEvents.id });
    return rows.length > 0;
  }
}

export async function openAlerts(db: Database, companyId: string) {
  return db
    .select()
    .from(alerts)
    .where(and(eq(alerts.companyId, companyId)));
}
